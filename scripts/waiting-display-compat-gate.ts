// Waiting display slice A (plan r2, WP A4): old client / new server and new client / old server.
//
//   node scripts/waiting-display-compat-gate.ts [baselineRef]
//
// 1. The new side writes its shells (apps/server/src/orchestration-v2/waitDisplayCompat.test.ts).
// 2. A detached worktree of the baseline (default 188a8db5) in the OS temp dir installs offline
//    from the pnpm store and runs scripts/waiting-display-compat/baseline.compat.test.ts.txt
//    there: the baseline contracts decode the new fixtures and its resolver reads them, then it
//    writes the baseline server's shells.
// 3. The new side decodes and resolves those.
// The worktree and fixtures are removed afterwards, pass or fail. Every child process is hidden.
import { spawnSync } from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

const BASELINE = process.argv[2] ?? "188a8db5ab473983e7ff9015050b02d13c798d4f";
const repo = NodePath.resolve(import.meta.dirname, "..");
const scratch = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-wait-compat-"));
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
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit",
    windowsHide: true,
    // vp and pnpm are .cmd shims on Windows.
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status ?? result.signal}`);
  }
}

let worktreeAdded = false;
try {
  run("vp", ["test", "run", testFile], NodePath.join(repo, "apps/server"), {
    T3_WAIT_COMPAT_WRITE: newFixtures,
  });
  run("git", ["worktree", "add", "--detach", baseline, BASELINE], repo);
  worktreeAdded = true;
  run("pnpm", ["install", "--frozen-lockfile", "--offline", "--ignore-scripts"], baseline);
  NodeFs.copyFileSync(
    NodePath.join(repo, "scripts/waiting-display-compat/baseline.compat.test.ts.txt"),
    NodePath.join(baseline, "apps/server", baselineTestFile),
  );
  run("vp", ["test", "run", baselineTestFile], NodePath.join(baseline, "apps/server"), {
    T3_WAIT_COMPAT_READ: newFixtures,
    T3_WAIT_COMPAT_WRITE: baseFixtures,
  });
  run("vp", ["test", "run", testFile], NodePath.join(repo, "apps/server"), {
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
  NodeFs.rmSync(scratch, { recursive: true, force: true });
}
