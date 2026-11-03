// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import {
  forgetActiveHookStageSession,
  getActiveHookStageSession,
  installHookStage,
  makeHookStageSession,
  prepareHookStage,
  rollbackInstalledHookFile,
  stageHookFile,
  writeHookStagedFile,
} from "./HookStagingManager.ts";

it.live("keeps staged candidates across a continuation and still checks the original", () =>
  Effect.promise(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "t3-hook-stage-resume-"));
    const first = makeHookStageSession({ workspaceRoot, threadId: "thread", runId: "first" });
    const resumed = makeHookStageSession({
      workspaceRoot,
      threadId: "thread",
      runId: "second",
      stageOriginRunId: "first",
    });
    try {
      await mkdir(join(workspaceRoot, "src"), { recursive: true });
      await writeFile(join(workspaceRoot, "src", "app.ts"), "original\n");
      await prepareHookStage(first);
      await stageHookFile(first, { path: "src/app.ts", create: false });
      await writeHookStagedFile(first, { path: "src/app.ts", contents: "candidate\n" });
      forgetActiveHookStageSession(first.threadId, first.runId);
      await prepareHookStage(resumed);
      expect(resumed.stageRoot).toBe(first.stageRoot);
      expect(await readFile(join(resumed.newRoot, "src", "app.ts"), "utf8")).toBe("candidate\n");
      await writeFile(join(workspaceRoot, "src", "app.ts"), "external\n");
      await expect(installHookStage(resumed)).rejects.toThrow("original changed after staging");
      expect(await readFile(join(workspaceRoot, "src", "app.ts"), "utf8")).toBe("external\n");
      await writeFile(join(workspaceRoot, "src", "app.ts"), "original\n");
      expect(await installHookStage(resumed)).toEqual(["src/app.ts"]);
      expect(await readFile(join(workspaceRoot, "src", "app.ts"), "utf8")).toBe("candidate\n");
      const missing = makeHookStageSession({
        workspaceRoot,
        threadId: "thread",
        runId: "third",
        stageOriginRunId: "missing",
      });
      await expect(prepareHookStage(missing)).rejects.toThrow();
    } finally {
      forgetActiveHookStageSession(first.threadId, first.runId);
      forgetActiveHookStageSession(resumed.threadId, resumed.runId);
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }),
);

it.live("keeps every file in the manifest when staging concurrently", () =>
  Effect.promise(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "t3-hook-stage-parallel-"));
    const session = makeHookStageSession({
      workspaceRoot,
      threadId: "thread-parallel",
      runId: "run-parallel",
    });
    try {
      await prepareHookStage(session);
      const paths = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
      await Promise.all(paths.map((path) => stageHookFile(session, { path, create: true })));
      await Promise.all(
        paths.map((path) => writeHookStagedFile(session, { path, contents: `${path}\n` })),
      );
      expect((await installHookStage(session)).sort()).toEqual(paths);
      for (const path of paths)
        expect(await readFile(join(workspaceRoot, path), "utf8")).toBe(`${path}\n`);
    } finally {
      forgetActiveHookStageSession(session.threadId, session.runId);
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }),
);

it.live("preserves a pre-existing manifest temporary and releases the stage lock on failure", () =>
  Effect.promise(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "t3-hook-stage-manifest-collision-"));
    const session = makeHookStageSession({
      workspaceRoot,
      threadId: "thread-manifest-collision",
      runId: "run-manifest-collision",
    });
    try {
      await prepareHookStage(session);
      const temporary = join(session.stageRoot, "manifest.json.tmp");
      await writeFile(temporary, "preserve me\n");
      await expect(stageHookFile(session, { path: "a.ts", create: true })).rejects.toThrow();
      expect(await readFile(temporary, "utf8")).toBe("preserve me\n");
      // A later operation must run even though the preceding one failed.
      await expect(stageHookFile(session, { path: "b.ts", create: true })).rejects.toThrow();
      expect(await readFile(temporary, "utf8")).toBe("preserve me\n");
    } finally {
      forgetActiveHookStageSession(session.threadId, session.runId);
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }),
);

it.live("writes only a manifest-listed staged candidate", () =>
  Effect.promise(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "t3-hook-stage-write-"));
    try {
      const session = makeHookStageSession({
        workspaceRoot,
        threadId: "thread-write",
        runId: "run-write",
      });
      await prepareHookStage(session);
      const staged = await stageHookFile(session, { path: "src/app.ts", create: true });
      const result = await writeHookStagedFile(session, {
        path: "src/app.ts",
        contents: "candidate\n",
      });
      expect(await readFile(staged.candidatePath, "utf8")).toBe("candidate\n");
      expect(result.candidatePath).toBe(staged.candidatePath);
      await expect(
        writeHookStagedFile(session, { path: "src/other.ts", contents: "escape" }),
      ).rejects.toThrow("Stage this project file before writing its candidate");
      await expect(
        writeHookStagedFile(session, { path: "../outside.ts", contents: "escape" }),
      ).rejects.toThrow("not eligible");
    } finally {
      forgetActiveHookStageSession("thread-write", "run-write");
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }),
);

it.live("installs only hash-verified staged candidates", () =>
  Effect.promise(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "t3-hook-stage-"));
    try {
      await mkdir(join(workspaceRoot, "src"), { recursive: true });
      await writeFile(join(workspaceRoot, "src", "app.ts"), "const value = 1;\n");
      const session = makeHookStageSession({
        workspaceRoot,
        threadId: "thread-test",
        runId: "run-test",
      });
      await prepareHookStage(session);
      expect(getActiveHookStageSession(session.threadId, session.runId)).toEqual(session);
      const staged = await stageHookFile(session, { path: "src/app.ts", create: false });
      expect(await readFile(staged.originalPath, "utf8")).toBe("const value = 1;\n");
      await writeFile(staged.candidatePath, "const value = 2;\n");

      expect(await installHookStage(session)).toEqual(["src/app.ts"]);
      expect(await readFile(join(workspaceRoot, "src", "app.ts"), "utf8")).toBe(
        "const value = 2;\n",
      );
      expect(await readFile(staged.originalPath, "utf8")).toBe("const value = 1;\n");
      forgetActiveHookStageSession(session.threadId, session.runId);
      expect(getActiveHookStageSession(session.threadId, session.runId)).toBeNull();
    } finally {
      forgetActiveHookStageSession("thread-test", "run-test");
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }),
);

it.live("blocks installation when the live source changes after staging", () =>
  Effect.promise(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "t3-hook-stage-conflict-"));
    try {
      await mkdir(join(workspaceRoot, "src"), { recursive: true });
      const source = join(workspaceRoot, "src", "app.ts");
      await writeFile(source, "original\n");
      const session = makeHookStageSession({
        workspaceRoot,
        threadId: "thread-test",
        runId: "run-conflict",
      });
      await prepareHookStage(session);
      const staged = await stageHookFile(session, { path: "src/app.ts", create: false });
      await writeFile(staged.candidatePath, "candidate\n");
      await writeFile(source, "external change\n");

      await expect(installHookStage(session)).rejects.toThrow("original changed after staging");
      expect(await readFile(source, "utf8")).toBe("external change\n");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }),
);

it.live("preserves an existing original backup when staging encounters a name collision", () =>
  Effect.promise(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "t3-hook-stage-original-collision-"));
    const session = makeHookStageSession({
      workspaceRoot,
      threadId: "thread-original-collision",
      runId: "run-original-collision",
    });
    try {
      await mkdir(join(workspaceRoot, "src"), { recursive: true });
      await writeFile(join(workspaceRoot, "src", "app.ts"), "live original\n");
      await prepareHookStage(session);
      await mkdir(join(session.originalRoot, "src"), { recursive: true });
      const existingBackup = join(session.originalRoot, "src", "app.ts");
      await writeFile(existingBackup, "previous backup\n");

      await expect(stageHookFile(session, { path: "src/app.ts", create: false })).rejects.toThrow();
      expect(await readFile(existingBackup, "utf8")).toBe("previous backup\n");
      expect(await readFile(join(workspaceRoot, "src", "app.ts"), "utf8")).toBe("live original\n");
    } finally {
      forgetActiveHookStageSession(session.threadId, session.runId);
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }),
);

it.live(
  "preserves an unrelated existing temporary file when installation encounters a collision",
  () =>
    Effect.promise(async () => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), "t3-hook-stage-temp-collision-"));
      const session = makeHookStageSession({
        workspaceRoot,
        threadId: "thread-temp-collision",
        runId: "run-temp-collision",
      });
      try {
        await mkdir(join(workspaceRoot, "src"), { recursive: true });
        const source = join(workspaceRoot, "src", "app.ts");
        await writeFile(source, "original\n");
        await prepareHookStage(session);
        const staged = await stageHookFile(session, { path: "src/app.ts", create: false });
        await writeFile(staged.candidatePath, "candidate\n");
        const suffix = createHash("sha256")
          .update(`${session.threadId}\0${session.runId}\0src/app.ts`)
          .digest("hex")
          .slice(0, 16);
        const existing = join(workspaceRoot, "src", `.app.ts.t3-hook-${suffix}.tmp`);
        await writeFile(existing, "unrelated file\n");

        await expect(installHookStage(session)).rejects.toThrow();
        expect(await readFile(existing, "utf8")).toBe("unrelated file\n");
        expect(await readFile(source, "utf8")).toBe("original\n");
      } finally {
        forgetActiveHookStageSession(session.threadId, session.runId);
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    }),
);

it.live("preserves newer live edits during rollback and restores an unchanged installed file", () =>
  Effect.promise(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "t3-hook-stage-rollback-conflict-"));
    const session = makeHookStageSession({
      workspaceRoot,
      threadId: "thread-rollback-conflict",
      runId: "run-rollback-conflict",
    });
    try {
      await mkdir(join(workspaceRoot, "src"), { recursive: true });
      const live = join(workspaceRoot, "src", "app.ts");
      await writeFile(live, "original\n");
      await prepareHookStage(session);
      const staged = await stageHookFile(session, { path: "src/app.ts", create: false });
      const entry = {
        path: "src/app.ts",
        originalExists: true,
        originalSha256: staged.originalSha256,
      };
      const candidate = "installed candidate\n";
      const installedHash = createHash("sha256").update(candidate).digest("hex");
      await writeFile(live, "newer edit\n");
      await expect(rollbackInstalledHookFile(session, entry, installedHash)).rejects.toThrow(
        "changed before rollback",
      );
      expect(await readFile(live, "utf8")).toBe("newer edit\n");

      await writeFile(live, candidate);
      await rollbackInstalledHookFile(session, entry, installedHash);
      expect(await readFile(live, "utf8")).toBe("original\n");
    } finally {
      forgetActiveHookStageSession(session.threadId, session.runId);
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }),
);

it.live("does not delete a newer version of a newly installed file during rollback", () =>
  Effect.promise(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "t3-hook-stage-new-rollback-"));
    const session = makeHookStageSession({
      workspaceRoot,
      threadId: "thread-new-rollback",
      runId: "run-new-rollback",
    });
    try {
      await prepareHookStage(session);
      await stageHookFile(session, { path: "new.txt", create: true });
      const live = join(workspaceRoot, "new.txt");
      await writeFile(live, "newer content\n");
      const installedHash = createHash("sha256").update("installed content\n").digest("hex");
      await expect(
        rollbackInstalledHookFile(
          session,
          { path: "new.txt", originalExists: false, originalSha256: null },
          installedHash,
        ),
      ).rejects.toThrow("changed before rollback");
      expect(await readFile(live, "utf8")).toBe("newer content\n");
    } finally {
      forgetActiveHookStageSession(session.threadId, session.runId);
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }),
);

it.live("blocks unmanifested candidates and staged path traversal", () =>
  Effect.promise(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "t3-hook-stage-extra-"));
    try {
      const session = makeHookStageSession({
        workspaceRoot,
        threadId: "thread-test",
        runId: "run-extra",
      });
      await prepareHookStage(session);
      await expect(stageHookFile(session, { path: "../outside.ts", create: true })).rejects.toThrow(
        "not eligible",
      );
      await writeFile(join(session.newRoot, "unlisted.ts"), "unlisted\n");
      await expect(installHookStage(session)).rejects.toThrow("approved stage manifest");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }),
);

it.live("creates a new file only when its target remains absent", () =>
  Effect.promise(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "t3-hook-stage-create-"));
    try {
      const session = makeHookStageSession({
        workspaceRoot,
        threadId: "thread-test",
        runId: "run-create",
      });
      await prepareHookStage(session);
      const staged = await stageHookFile(session, { path: "src/new.ts", create: true });
      await writeFile(staged.candidatePath, "export const value = 1;\n");
      await mkdir(join(workspaceRoot, "src"), { recursive: true });
      await writeFile(join(workspaceRoot, "src", "new.ts"), "external file\n");

      await expect(installHookStage(session)).rejects.toThrow("target appeared after staging");
      expect(await readFile(join(workspaceRoot, "src", "new.ts"), "utf8")).toBe("external file\n");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }),
);

it.live("rejects junctions in live and staged paths", () =>
  Effect.promise(async () => {
    const tempRoot = resolve(tmpdir());
    const workspaceRoot = await mkdtemp(join(tempRoot, "t3-hook-stage-junction-"));
    if (!resolve(workspaceRoot).startsWith(`${tempRoot}${sep}`)) {
      throw new Error("Fixture directory is outside the intended temporary root");
    }
    const session = makeHookStageSession({
      workspaceRoot,
      threadId: "thread-junction-test",
      runId: "run-junction-test",
    });
    try {
      const target = join(workspaceRoot, "target");
      await mkdir(target);
      await writeFile(join(target, "protected.ts"), "unchanged\n");
      await symlink(
        target,
        join(workspaceRoot, "shortcut"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await prepareHookStage(session);
      await expect(
        stageHookFile(session, { path: "shortcut/protected.ts", create: false }),
      ).rejects.toThrow("Symbolic links are not stageable");
      await symlink(
        target,
        join(session.newRoot, "shortcut"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(installHookStage(session)).rejects.toThrow(
        "Staged directories cannot contain symbolic links",
      );
      expect(await readFile(join(target, "protected.ts"), "utf8")).toBe("unchanged\n");
    } finally {
      forgetActiveHookStageSession(session.threadId, session.runId);
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }),
);
