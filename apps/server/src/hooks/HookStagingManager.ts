// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";
import * as Schema from "effect/Schema";

export type HookStagedFile = {
  readonly path: string;
  readonly originalExists: boolean;
  readonly originalSha256: string | null;
};

export type HookStageSession = {
  readonly workspaceRoot: string;
  readonly threadId: string;
  readonly runId: string;
  readonly stageRoot: string;
  readonly originalRoot: string;
  readonly newRoot: string;
  readonly resuming: boolean;
};

const activeHookStageSessions = new Map<string, HookStageSession>();
const pendingStageOperations = new Map<string, Promise<void>>();

// One server may receive concurrent tool calls for the same staging directory.
// Serialize the entire operation, including manifest reads and candidate installation.
async function withStageLock<T>(
  session: HookStageSession,
  operation: () => Promise<T>,
): Promise<T> {
  const key = NodePath.sep === "\\" ? session.stageRoot.toLowerCase() : session.stageRoot;
  const previous = pendingStageOperations.get(key);
  let release!: () => void;
  const finished = new Promise<void>((resolve) => {
    release = resolve;
  });
  pendingStageOperations.set(key, finished);
  if (previous) await previous;
  try {
    return await operation();
  } finally {
    release();
    if (pendingStageOperations.get(key) === finished) pendingStageOperations.delete(key);
  }
}

const hookStageSessionKey = (threadId: string, runId: string) => `${threadId}\0${runId}`;

export function getActiveHookStageSession(threadId: string, runId: string) {
  return activeHookStageSessions.get(hookStageSessionKey(threadId, runId)) ?? null;
}

export function forgetActiveHookStageSession(threadId: string, runId: string) {
  activeHookStageSessions.delete(hookStageSessionKey(threadId, runId));
}

export class HookStagingError extends Schema.TaggedError<HookStagingError>()("HookStagingError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const stagingError = (message: string, cause?: unknown) =>
  new HookStagingError({ message, ...(cause === undefined ? {} : { cause }) });

const sha256 = async (filePath: string) => {
  const hash = NodeCrypto.createHash("sha256");
  await NodeStreamPromises.pipeline(NodeFS.createReadStream(filePath), async function (source) {
    for await (const chunk of source) hash.update(chunk);
  });
  return hash.digest("hex");
};

const inside = (root: string, target: string) => {
  const path = NodePath.relative(root, target);
  return (
    path !== "" &&
    !NodePath.isAbsolute(path) &&
    path !== ".." &&
    !path.startsWith(`..${NodePath.sep}`)
  );
};

export function sameHookWorkspace(left: string, right: string): boolean {
  const normalize = (path: string) => {
    const absolute = NodePath.resolve(path);
    return NodePath.sep === "\\" ? absolute.toLowerCase() : absolute;
  };
  return normalize(left) === normalize(right);
}

const lstatOrNull = async (filePath: string) => {
  try {
    return await NodeFSP.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const safeRelativePath = (candidate: string) => {
  if (candidate.trim() === "" || NodePath.isAbsolute(candidate))
    throw stagingError("Use a nonempty path relative to the managed worktree.");
  const normalized = candidate.split(/[\\/]+/).join(NodePath.sep);
  const parts = normalized.split(NodePath.sep);
  if (
    parts.some(
      (part) =>
        part === "" ||
        part === "." ||
        part === ".." ||
        part.includes(":") ||
        part.toLowerCase() === ".git",
    ) ||
    (parts[0]?.toLowerCase() === "backups" && parts[1]?.toLowerCase() === "t3 code")
  )
    throw stagingError("That path is not eligible for staged editing.");
  return parts.join("/");
};

async function assertNoSymlinkComponents(root: string, target: string, allowMissingLeaf: boolean) {
  const rel = NodePath.relative(root, target);
  if (NodePath.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${NodePath.sep}`))
    throw stagingError("The path leaves the managed worktree.");
  let current = root;
  const segments = rel.split(NodePath.sep);
  for (let index = 0; index < segments.length; index += 1) {
    current = NodePath.join(current, segments[index]!);
    try {
      const info = await NodeFSP.lstat(current);
      if (info.isSymbolicLink()) throw stagingError("Symbolic links are not stageable.");
      if (index < segments.length - 1 && !info.isDirectory())
        throw stagingError("A parent path component is not a directory.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissingLeaf) return;
      throw error;
    }
  }
}

async function readManifest(session: HookStageSession): Promise<HookStagedFile[]> {
  const manifestPath = NodePath.join(session.stageRoot, "manifest.json");
  try {
    const value: unknown = JSON.parse(await NodeFSP.readFile(manifestPath, "utf8"));
    if (!Array.isArray(value)) throw new Error("not an array");
    return value.map((entry) => {
      if (
        entry === null ||
        typeof entry !== "object" ||
        typeof entry.path !== "string" ||
        typeof entry.originalExists !== "boolean" ||
        !(entry.originalSha256 === null || typeof entry.originalSha256 === "string")
      )
        throw new Error("invalid entry");
      safeRelativePath(entry.path);
      if (entry.originalSha256 !== null && !/^[a-f0-9]{64}$/.test(entry.originalSha256))
        throw new Error("invalid hash");
      return entry as HookStagedFile;
    });
  } catch (cause) {
    throw stagingError("The staged-file manifest could not be verified.", cause);
  }
}

async function writeManifest(session: HookStageSession, files: ReadonlyArray<HookStagedFile>) {
  const target = NodePath.join(session.stageRoot, "manifest.json");
  const temporary = `${target}.tmp`;
  const handle = await NodeFSP.open(temporary, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(files, null, 2)}\n`);
    await handle.close();
    await NodeFSP.rename(temporary, target);
  } catch (cause) {
    await handle.close().catch(() => undefined);
    await NodeFSP.unlink(temporary).catch(() => undefined);
    throw cause;
  }
}

async function copyStream(source: string, target: string) {
  await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
  const targetHandle = await NodeFSP.open(target, "wx");
  try {
    await NodeStreamPromises.pipeline(
      NodeFS.createReadStream(source),
      targetHandle.createWriteStream(),
    );
  } catch (cause) {
    await targetHandle.close().catch(() => undefined);
    await NodeFSP.unlink(target).catch(() => undefined);
    throw cause;
  }
}

export function makeHookStageSession(input: {
  readonly workspaceRoot: string;
  readonly threadId: string;
  readonly runId: string;
  readonly stageOriginRunId?: string;
}): HookStageSession {
  const workspaceRoot = NodePath.resolve(input.workspaceRoot);
  const key = NodeCrypto.createHash("sha256")
    .update(`${input.threadId}\0${input.stageOriginRunId ?? input.runId}`)
    .digest("hex")
    .slice(0, 24);
  const stageRoot = NodePath.join(workspaceRoot, "backups", "T3 Code", "staging", "T3Hooks", key);
  if (!inside(workspaceRoot, stageRoot)) throw stagingError("Invalid staging path.");
  return {
    workspaceRoot,
    threadId: input.threadId,
    runId: input.runId,
    stageRoot,
    originalRoot: NodePath.join(stageRoot, "original"),
    newRoot: NodePath.join(stageRoot, "new"),
    resuming: input.stageOriginRunId !== undefined,
  };
}

export function prepareHookStage(session: HookStageSession) {
  return withStageLock(session, () => prepareHookStageLocked(session));
}

async function prepareHookStageLocked(session: HookStageSession) {
  await assertNoSymlinkComponents(session.workspaceRoot, session.stageRoot, !session.resuming);
  if (!session.resuming) {
    await NodeFSP.mkdir(session.originalRoot, { recursive: true });
    await NodeFSP.mkdir(session.newRoot, { recursive: true });
  }
  await assertNoSymlinkComponents(session.workspaceRoot, session.originalRoot, false);
  await assertNoSymlinkComponents(session.workspaceRoot, session.newRoot, false);
  if (!(await NodeFSP.stat(session.newRoot)).isDirectory())
    throw stagingError("The staging new directory is not a directory.");
  if (!(await NodeFSP.stat(session.originalRoot)).isDirectory())
    throw stagingError("The staging original directory is not a directory.");
  const manifest = NodePath.join(session.stageRoot, "manifest.json");
  await assertNoSymlinkComponents(session.stageRoot, manifest, !session.resuming);
  if (session.resuming) {
    await readManifest(session);
  } else {
    await NodeFSP.writeFile(manifest, "[]\n", { flag: "wx" }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
  }
  activeHookStageSessions.set(hookStageSessionKey(session.threadId, session.runId), session);
}

export function stageHookFile(
  session: HookStageSession,
  input: { readonly path: string; readonly create: boolean },
) {
  return withStageLock(session, () => stageHookFileLocked(session, input));
}

async function stageHookFileLocked(
  session: HookStageSession,
  input: { readonly path: string; readonly create: boolean },
) {
  const relativePath = safeRelativePath(input.path);
  const source = NodePath.join(session.workspaceRoot, relativePath);
  const original = NodePath.join(session.originalRoot, relativePath);
  const candidate = NodePath.join(session.newRoot, relativePath);
  if (
    !inside(session.workspaceRoot, source) ||
    !inside(session.originalRoot, original) ||
    !inside(session.newRoot, candidate)
  )
    throw stagingError("The staged path leaves its allowed root.");
  await assertNoSymlinkComponents(session.workspaceRoot, source, true);
  await assertNoSymlinkComponents(session.newRoot, candidate, true);
  const existing = await lstatOrNull(source);
  if (input.create && existing !== null) throw stagingError("The file already exists.");
  if (!input.create && (existing === null || !existing.isFile()))
    throw stagingError("Only an existing regular file can be staged for editing.");
  if (await lstatOrNull(candidate)) throw stagingError("That file is already staged for this run.");

  const files = await readManifest(session);
  if (files.some((file) => file.path === relativePath))
    throw stagingError("That file is already listed in the stage manifest.");
  let originalSha256: string | null = null;
  if (existing !== null) {
    await assertNoSymlinkComponents(session.originalRoot, original, true);
    await copyStream(source, original);
    originalSha256 = await sha256(original);
    if (originalSha256 !== (await sha256(source)))
      throw stagingError("The source changed while it was being staged.");
    await copyStream(original, candidate);
    if (originalSha256 !== (await sha256(candidate)))
      throw stagingError("The staged candidate did not match its original copy.");
  } else {
    await NodeFSP.mkdir(NodePath.dirname(candidate), { recursive: true });
    await NodeFSP.writeFile(candidate, "", { flag: "wx" });
  }
  const next = [
    ...files,
    { path: relativePath, originalExists: existing !== null, originalSha256 },
  ];
  await writeManifest(session, next);
  return { candidatePath: candidate, originalPath: original, originalSha256 };
}

export function writeHookStagedFile(
  session: HookStageSession,
  input: { readonly path: string; readonly contents: string },
) {
  return withStageLock(session, () => writeHookStagedFileLocked(session, input));
}

async function writeHookStagedFileLocked(
  session: HookStageSession,
  input: { readonly path: string; readonly contents: string },
) {
  const relativePath = safeRelativePath(input.path);
  const candidate = NodePath.join(session.newRoot, relativePath);
  if (!inside(session.newRoot, candidate))
    throw stagingError("The staged path leaves its allowed root.");
  const files = await readManifest(session);
  if (!files.some((file) => file.path === relativePath))
    throw stagingError("Stage this project file before writing its candidate.");
  await assertNoSymlinkComponents(session.newRoot, candidate, false);
  const info = await NodeFSP.lstat(candidate);
  if (!info.isFile()) throw stagingError("Only a staged regular file can be written.");
  await NodeFSP.writeFile(candidate, input.contents, { flag: "w" });
  return { candidatePath: candidate, sha256: await sha256(candidate) };
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const entries = await NodeFSP.readdir(current, { withFileTypes: true });
  const output: string[] = [];
  for (const entry of entries) {
    const entryPath = NodePath.join(current, entry.name);
    if (entry.isSymbolicLink())
      throw stagingError("Staged directories cannot contain symbolic links.");
    if (entry.isDirectory()) output.push(...(await listFiles(root, entryPath)));
    else if (entry.isFile())
      output.push(NodePath.relative(root, entryPath).split(NodePath.sep).join("/"));
    else throw stagingError("The staged directory contains a non-regular file.");
  }
  return output;
}

export async function rollbackInstalledHookFile(
  session: HookStageSession,
  file: HookStagedFile,
  installedSha256: string,
) {
  const relativePath = safeRelativePath(file.path);
  const destination = NodePath.join(session.workspaceRoot, relativePath);
  if (!inside(session.workspaceRoot, destination)) throw stagingError("Invalid rollback target.");
  const verifyInstalledFile = async () => {
    await assertNoSymlinkComponents(session.workspaceRoot, destination, false);
    const current = await lstatOrNull(destination);
    if (current === null || !current.isFile() || (await sha256(destination)) !== installedSha256)
      throw stagingError(`The installed file changed before rollback: ${relativePath}`);
  };
  await verifyInstalledFile();
  if (!file.originalExists) {
    await verifyInstalledFile();
    await NodeFSP.unlink(destination);
    return;
  }
  const original = NodePath.join(session.originalRoot, relativePath);
  await assertNoSymlinkComponents(session.originalRoot, original, false);
  const temporary = `${destination}.t3-hook-rollback-${NodeCrypto.createHash("sha256").update(`${session.runId}\0${file.path}`).digest("hex").slice(0, 12)}.tmp`;
  let prepared = false;
  try {
    await copyStream(original, temporary);
    prepared = true;
    if ((await sha256(temporary)) !== file.originalSha256)
      throw stagingError(`Rollback copy failed SHA-256 verification: ${relativePath}`);
    await verifyInstalledFile();
    await NodeFSP.rename(temporary, destination);
    prepared = false;
  } finally {
    if (prepared) await NodeFSP.unlink(temporary).catch(() => undefined);
  }
}

export function installHookStage(session: HookStageSession) {
  return withStageLock(session, () => installHookStageLocked(session));
}

async function installHookStageLocked(session: HookStageSession) {
  const files = await readManifest(session);
  const candidates = await listFiles(session.newRoot);
  const expected = new Set(files.map((file) => file.path));
  if (
    candidates.some((file) => !expected.has(file)) ||
    files.some((file) => !candidates.includes(file.path))
  )
    throw stagingError("The candidate files do not match the approved stage manifest.");

  const prepared = [] as Array<{
    readonly file: HookStagedFile;
    readonly source: string;
    readonly candidate: string;
    readonly candidateSha256: string;
    readonly temporary: string;
  }>;
  for (const file of files) {
    const source = NodePath.join(session.workspaceRoot, file.path);
    const original = NodePath.join(session.originalRoot, file.path);
    const candidate = NodePath.join(session.newRoot, file.path);
    await assertNoSymlinkComponents(session.workspaceRoot, source, true);
    await assertNoSymlinkComponents(session.newRoot, candidate, false);
    const live = await lstatOrNull(source);
    if (file.originalExists) {
      if (
        live === null ||
        !live.isFile() ||
        (await sha256(original)) !== file.originalSha256 ||
        (await sha256(source)) !== file.originalSha256
      )
        throw stagingError(`The original changed after staging: ${file.path}`);
    } else if (live !== null) {
      throw stagingError(`A new-file target appeared after staging: ${file.path}`);
    }
    const candidateInfo = await NodeFSP.lstat(candidate);
    if (!candidateInfo.isFile())
      throw stagingError(`Candidate is not a regular file: ${file.path}`);
    prepared.push({
      file,
      source,
      candidate,
      candidateSha256: await sha256(candidate),
      temporary: NodePath.join(
        NodePath.dirname(source),
        `.${NodePath.basename(source)}.t3-hook-${NodeCrypto.createHash("sha256").update(`${session.threadId}\0${session.runId}\0${file.path}`).digest("hex").slice(0, 16)}.tmp`,
      ),
    });
  }

  const installed: string[] = [];
  const temporaries = new Set<string>();
  try {
    // Prepare every same-directory replacement before touching a live file. This keeps
    // copy/space/permission errors in the preflight phase rather than halfway through install.
    for (const entry of prepared) {
      await NodeFSP.mkdir(NodePath.dirname(entry.source), { recursive: true });
      await copyStream(entry.candidate, entry.temporary);
      temporaries.add(entry.temporary);
      if ((await sha256(entry.temporary)) !== entry.candidateSha256)
        throw stagingError(`Prepared install copy failed SHA-256 verification: ${entry.file.path}`);
    }
    for (const entry of prepared) {
      // Recheck immediately before replacement to catch edits made after initial preflight.
      await assertNoSymlinkComponents(session.workspaceRoot, entry.source, true);
      const live = await lstatOrNull(entry.source);
      if (entry.file.originalExists) {
        if (
          live === null ||
          !live.isFile() ||
          (await sha256(entry.source)) !== entry.file.originalSha256
        )
          throw stagingError(`The original changed during installation: ${entry.file.path}`);
      } else if (live !== null) {
        throw stagingError(`A new-file target appeared during installation: ${entry.file.path}`);
      }
      await NodeFSP.rename(entry.temporary, entry.source);
      temporaries.delete(entry.temporary);
      installed.push(entry.file.path);
      if ((await sha256(entry.source)) !== entry.candidateSha256)
        throw stagingError(`Installed file failed SHA-256 verification: ${entry.file.path}`);
    }
  } catch (cause) {
    const rollbackFailures: string[] = [];
    for (const path of installed.reverse()) {
      const entry = prepared.find((candidate) => candidate.file.path === path)!;
      await rollbackInstalledHookFile(session, entry.file, entry.candidateSha256).catch(() =>
        rollbackFailures.push(path),
      );
    }
    const message =
      rollbackFailures.length === 0
        ? "Host-side installation failed; any installed changes were rolled back and staged originals were retained."
        : "Host-side installation failed and rollback needs attention for " +
          rollbackFailures.join(", ") +
          ". Staged originals were retained for recovery.";
    throw stagingError(message, cause);
  } finally {
    await Promise.all(
      [...temporaries].map((temporary) => NodeFSP.unlink(temporary).catch(() => undefined)),
    );
  }
  return installed;
}
