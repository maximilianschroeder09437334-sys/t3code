// Waiting display compat gate: `node scripts/waiting-display-compat-gate.ts [baselineRef]`. Runs the
// new/old client and server fixture checks against a temporary detached baseline worktree in the
// OS temp dir; the worktree and fixtures are removed afterwards. Every child process is hidden.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const BASELINE = process.argv[2] ?? "188a8db5ab473983e7ff9015050b02d13c798d4f";
const repo = NodePath.resolve(import.meta.dirname, "..");
const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-wait-compat-"));
const newFixtures = NodePath.join(scratch, "new");
const baseFixtures = NodePath.join(scratch, "base");
const baseline = NodePath.join(scratch, "baseline");
const testFile = "src/orchestration-v2/waitDisplayCompat.test.ts";
const baselineTestFile = "src/orchestration-v2/waitDisplayCompat.baseline.test.ts";

function run(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: Record<string, string> = {},
): void {
  console.log(`$ (${NodePath.relative(scratch, cwd) || cwd}) ${command} ${args.join(" ")}`);
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit",
    windowsHide: true,
    // The vp shim is a .cmd file on Windows.
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Node tooling has no Effect runtime.
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status ?? result.signal}`);
  }
}

// vp (and the pnpm it manages) need not be on PATH: use each checkout's own shim.
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Node tooling has no Effect runtime.
const vpShim = process.platform === "win32" ? "vp.cmd" : "vp";
const vp = (root: string) => JSON.stringify(NodePath.join(root, "node_modules", ".bin", vpShim));

let worktreeAdded = false;
try {
  run(vp(repo), ["test", "run", testFile], NodePath.join(repo, "apps/server"), {
    T3_WAIT_COMPAT_WRITE: newFixtures,
  });
  run("git", ["worktree", "add", "--detach", baseline, BASELINE], repo);
  worktreeAdded = true;
  run(vp(repo), ["install", "--frozen-lockfile", "--offline", "--ignore-scripts"], baseline);
  NodeFS.copyFileSync(
    NodePath.join(repo, "scripts/waiting-display-compat/baseline.compat.test.ts.txt"),
    NodePath.join(baseline, "apps/server", baselineTestFile),
  );
  run(vp(baseline), ["test", "run", baselineTestFile], NodePath.join(baseline, "apps/server"), {
    T3_WAIT_COMPAT_READ: newFixtures,
    T3_WAIT_COMPAT_WRITE: baseFixtures,
  });
  run(vp(repo), ["test", "run", testFile], NodePath.join(repo, "apps/server"), {
    T3_WAIT_COMPAT_READ: baseFixtures,
  });
  console.log("waiting display compatibility gate: PASS");
} catch (error) {
  console.error("waiting display compatibility gate: FAIL");
  console.error(error);
  process.exitCode = 1;
} finally {
  if (worktreeAdded) {
    try {
      run("git", ["worktree", "remove", "--force", baseline], repo);
    } catch (error) {
      console.error(`could not remove the baseline worktree ${baseline}:`, error);
      process.exitCode = 1;
    }
  }
  NodeFS.rmSync(scratch, { recursive: true, force: true });
}
