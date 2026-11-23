// `node scripts/takeover-compat-gate-23.ts [baselineRef]`: takeover vs desktop .23 (cc15112571) on
// fixtures only (never the live database), in a temporary baseline worktree removed afterwards:
// wire decode both ways, then .23 state on .24, the rollback preflight, and .24 state on .23.
// The 188a8db5 wire gate stays scripts/waiting-display-compat-gate.ts. Every child is hidden.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const BASELINE = process.argv[2] ?? "cc15112571e876356a2fbc704d3e416bfa1f5011";
const repo = NodePath.resolve(import.meta.dirname, "..");
const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-takeover-compat-"));
const newFixtures = NodePath.join(scratch, "wire-new");
const baseFixtures = NodePath.join(scratch, "wire-base");
const stateFixtures = NodePath.join(scratch, "state");
const baseline = NodePath.join(scratch, "baseline");
const wireTest = "src/orchestration-v2/waitDisplayCompat.test.ts";
const wireBaselineTest = "src/orchestration-v2/waitDisplayCompat.baseline23.test.ts";
const stateTest = "src/orchestration-v2/ThreadTakeover.integration.test.ts";

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

// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Node tooling has no Effect runtime.
const vpShim = process.platform === "win32" ? "vp.cmd" : "vp";
const vp = (root: string) => JSON.stringify(NodePath.join(root, "node_modules", ".bin", vpShim));
const server = (root: string) => NodePath.join(root, "apps/server");
const stateStep = (root: string, step: string) =>
  run(vp(root), ["test", "run", stateTest, "-t", JSON.stringify("compat gate")], server(root), {
    T3_TAKEOVER_COMPAT_DIR: stateFixtures,
    T3_TAKEOVER_COMPAT_STEP: step,
  });

let worktreeAdded = false;
try {
  NodeFS.mkdirSync(stateFixtures, { recursive: true });
  run(vp(repo), ["test", "run", wireTest], server(repo), { T3_WAIT_COMPAT_WRITE: newFixtures });
  run("git", ["worktree", "add", "--detach", baseline, BASELINE], repo);
  worktreeAdded = true;
  run(vp(repo), ["install", "--frozen-lockfile", "--offline", "--ignore-scripts"], baseline);
  NodeFS.copyFileSync(
    NodePath.join(repo, "scripts/waiting-display-compat/baseline23.compat.test.ts.txt"),
    NodePath.join(server(baseline), wireBaselineTest),
  );
  // The takeover test file loads on .23 (its takeover calls go through a baseline adapter), so
  // the .23 steps run this branch's fixtures with .23's own stores and startup.
  NodeFS.copyFileSync(
    NodePath.join(server(repo), stateTest),
    NodePath.join(server(baseline), stateTest),
  );
  run(vp(baseline), ["test", "run", wireBaselineTest], server(baseline), {
    T3_WAIT_COMPAT_READ: newFixtures,
    T3_WAIT_COMPAT_WRITE: baseFixtures,
  });
  run(vp(repo), ["test", "run", wireTest], server(repo), { T3_WAIT_COMPAT_READ: baseFixtures });
  stateStep(baseline, "write-23");
  stateStep(repo, "on-24");
  stateStep(baseline, "read-24");
  for (const name of ["from24-open.json", "observed-23-on-open.json"]) {
    console.log(`--- ${name}\n${NodeFS.readFileSync(NodePath.join(stateFixtures, name), "utf8")}`);
  }
  console.log("takeover .23 compatibility gate: PASS");
} catch (error) {
  console.error("takeover .23 compatibility gate: FAIL");
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
