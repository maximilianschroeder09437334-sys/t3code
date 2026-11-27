"""Upstream release watcher for the T3 Code fork (plan item 4.1, Part A).

Run: pythonw t3_upstream_watch.py --config <path> [--dry-run]
Checks the newest upstream tag on the configured channel. Nothing new: one log line, exit 0.
New tag: counts commits and merge conflicts, then starts one T3 report thread that asks Maxi
for an OK. It never merges, pushes, or opens a merge thread itself.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable

STABLE_PATTERN = r"^v\d+\.\d+\.\d+$"
REQUIRED_KEYS = (
    "mirrorPath",
    "upstreamUrl",
    "forkRemote",
    "forkBranch",
    "projectId",
    "reportProvider",
    "reportModel",
    "statePath",
    "logPath",
    "areaRules",
    "t3Command",
)
DEFAULTS = {"channelPattern": STABLE_PATTERN, "commandTimeoutSec": 600}
PATH_KEYS = ("mirrorPath", "statePath", "logPath")
FORK_REF = "refs/watch/fork"
OTHER_AREA = "other"
TITLE = "T3 Code: upstream {tag} ready, merge?"
VERSION_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$")


class WatchError(Exception):
    pass


class ConfigError(WatchError):
    pass


@dataclass(frozen=True)
class Result:
    code: int
    out: str
    err: str = ""


Runner = Callable[..., Result]


def run_hidden(argv: list[str], stdin: str | None = None, timeout: float | None = None) -> Result:
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        p = subprocess.run(
            argv,
            input=stdin,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            creationflags=flags,
        )
    except subprocess.TimeoutExpired:
        return Result(124, "", f"timed out after {timeout}s: {argv[0]}")
    except OSError as e:
        return Result(127, "", f"cannot run {argv[0]}: {e}")
    return Result(p.returncode, p.stdout, p.stderr)


# --- config and state -------------------------------------------------------


def load_config(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError) as e:
        raise ConfigError(f"cannot read config {path}: {e}") from e
    return validate_config(raw, path)


def validate_config(raw: object, source: str = "config") -> dict:
    if not isinstance(raw, dict):
        raise ConfigError(f"{source}: top level must be a JSON object")
    missing = [k for k in REQUIRED_KEYS if raw.get(k) in (None, "")]
    if missing:
        raise ConfigError(f"{source}: missing required key(s): {', '.join(missing)}")
    cfg = {**DEFAULTS, **raw}
    rules = cfg["areaRules"]
    if not isinstance(rules, dict) or not all(
        isinstance(k, str) and isinstance(v, str) for k, v in rules.items()
    ):
        raise ConfigError(f"{source}: areaRules must map path prefix -> area name (strings)")
    cmd = cfg["t3Command"]
    if not isinstance(cmd, list) or not cmd or not all(isinstance(a, str) for a in cmd):
        raise ConfigError(f"{source}: t3Command must be a non-empty list of strings")
    try:
        re.compile(cfg["channelPattern"])
    except re.error as e:
        raise ConfigError(f"{source}: channelPattern is not a valid regex: {e}") from e
    for k in PATH_KEYS:
        cfg[k] = os.path.expanduser(cfg[k])
    return cfg


def load_state(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        raise WatchError(f"cannot read state {path}: {e}") from e
    return data if isinstance(data, dict) else {}


def save_state(path: str, state: dict) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def append_log(path: str, now: datetime, status: str, detail: str = "") -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    stamp = now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    one_line = " ".join(detail.split())
    with open(path, "a", encoding="utf-8") as f:
        f.write(f"{stamp} {status} {one_line}".rstrip() + "\n")


# --- pure logic ---------------------------------------------------------------


def version_key(tag: str) -> tuple | None:
    m = VERSION_RE.match(tag)
    if not m:
        return None
    core = tuple(int(x) for x in m.group(1, 2, 3))
    pre = m.group(4)
    if pre is None:
        return (core, (1,))
    # Semver precedence: a prerelease sorts below its release; numeric ids below alphanumeric.
    ids = tuple((0, int(p), "") if p.isdigit() else (1, 0, p) for p in pre.split("."))
    return (core, (0, *ids))


def pick_newest(tags: list[str], channel_pattern: str) -> str | None:
    rx = re.compile(channel_pattern)
    candidates = [t for t in tags if rx.search(t) and version_key(t) is not None]
    return max(candidates, key=version_key, default=None)


def is_newer(tag: str, last: str | None) -> bool:
    if not last:
        return True
    last_key = version_key(last)
    if last_key is None:
        return tag != last
    return version_key(tag) > last_key


def parse_merge_tree(result: Result) -> list[str]:
    """`git merge-tree --write-tree --name-only --no-messages`: exit 0 clean, 1 conflicts."""
    if result.code not in (0, 1):
        raise WatchError(f"git merge-tree failed ({result.code}): {result.err.strip()}")
    files: list[str] = []
    for line in result.out.splitlines()[1:]:
        if not line.strip():
            break
        files.append(line)
    return files


def area_of(path: str, area_rules: dict[str, str]) -> str:
    matches = [p for p in area_rules if path.startswith(p)]
    return area_rules[max(matches, key=len)] if matches else OTHER_AREA


def group_by_area(files: list[str], area_rules: dict[str, str]) -> list[tuple[str, int]]:
    counts: dict[str, int] = {}
    for f in files:
        area = area_of(f, area_rules)
        counts[area] = counts.get(area, 0) + 1
    return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))


@dataclass(frozen=True)
class Report:
    tag: str
    tag_sha: str
    previous_tag: str | None
    fork_branch: str
    fork_sha: str
    upstream_ahead: int
    fork_only: int
    conflicts: list[str]
    areas: list[tuple[str, int]]

    @property
    def title(self) -> str:
        return TITLE.format(tag=self.tag)

    @property
    def message(self) -> str:
        lines = [
            f"Upstream released {self.tag} ({self.tag_sha[:10]}). "
            f"Last reported: {self.previous_tag or 'none'}.",
            f"Compared with fork branch {self.fork_branch} ({self.fork_sha[:10]}):",
            f"- Upstream commits not in the fork: {self.upstream_ahead}",
            f"- Fork-only commits (non-merge): {self.fork_only}",
            f"- Conflicted files (git merge-tree): {len(self.conflicts)}",
        ]
        lines += [f"  - {area}: {n}" for area, n in self.areas]
        lines += [
            "",
            "Instruction: report the numbers above to Maxi in plain words, then ask exactly "
            '"Reply OK to open the merge thread." and stop.',
            "Do not merge, push, or start any thread or worktree unless Maxi replies OK.",
        ]
        return "\n".join(lines)


# --- run ----------------------------------------------------------------------


class Git:
    def __init__(self, runner: Runner, cfg: dict):
        self.runner = runner
        self.mirror = cfg["mirrorPath"]
        self.timeout = cfg["commandTimeoutSec"]

    def raw(self, *args: str) -> Result:
        argv = ["git", "-c", "core.quotePath=false", "--git-dir", self.mirror, *args]
        return self.runner(argv, timeout=self.timeout)

    def __call__(self, *args: str) -> str:
        r = self.raw(*args)
        if r.code != 0:
            raise WatchError(f"git {args[0]} failed ({r.code}): {r.err.strip()}")
        return r.out


def refresh_mirror(git: Git, cfg: dict) -> None:
    # Bare repo with only tags + the fork branch; `clone --mirror` of GitHub pulls every PR ref too.
    if not os.path.isdir(cfg["mirrorPath"]):
        git("init", "--bare", "--quiet", cfg["mirrorPath"])
    git("fetch", "--quiet", "--no-tags", "--force", cfg["upstreamUrl"], "+refs/tags/*:refs/tags/*")
    git(
        "fetch",
        "--quiet",
        "--no-tags",
        "--force",
        cfg["forkRemote"],
        f"+refs/heads/{cfg['forkBranch']}:{FORK_REF}",
    )


def build_report(git: Git, cfg: dict, tag: str, previous: str | None) -> Report:
    # Peeled commit ids: upstream tags may be annotated, and every count must use the same commits.
    tag_sha, fork_sha = git("rev-parse", f"refs/tags/{tag}^{{commit}}", FORK_REF).split()
    ahead = int(git("rev-list", "--count", f"{fork_sha}..{tag_sha}").strip())
    fork_only = int(git("rev-list", "--count", "--no-merges", f"{tag_sha}..{fork_sha}").strip())
    conflicts = parse_merge_tree(
        git.raw("merge-tree", "--write-tree", "--name-only", "--no-messages", fork_sha, tag_sha)
    )
    return Report(
        tag=tag,
        tag_sha=tag_sha,
        previous_tag=previous,
        fork_branch=cfg["forkBranch"],
        fork_sha=fork_sha,
        upstream_ahead=ahead,
        fork_only=fork_only,
        conflicts=conflicts,
        areas=group_by_area(conflicts, cfg["areaRules"]),
    )


def start_report_thread(runner: Runner, cfg: dict, report: Report) -> str | None:
    argv = [
        *cfg["t3Command"],
        "thread",
        "start",
        "--title",
        report.title,
        "--provider",
        cfg["reportProvider"],
        "--model",
        cfg["reportModel"],
        "--json",
        cfg["projectId"],
        "-",
    ]
    r = runner(argv, stdin=report.message, timeout=cfg["commandTimeoutSec"])
    if r.code != 0:
        raise WatchError(f"t3 thread start failed ({r.code}): {r.err.strip()[-300:]}")
    try:
        return json.loads(r.out).get("threadId")
    except (ValueError, AttributeError):
        return None


def run(
    cfg: dict,
    runner: Runner = run_hidden,
    *,
    dry_run: bool = False,
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    out: Callable[[str], None] = print,
) -> int:
    def log(status: str, detail: str = "") -> None:
        append_log(cfg["logPath"], now(), status, detail)

    try:
        git = Git(runner, cfg)
        refresh_mirror(git, cfg)
        newest = pick_newest(git("tag", "--list").split(), cfg["channelPattern"])
        if newest is None:
            log("no-tag", f"nothing matches {cfg['channelPattern']}")
            return 0
        state = load_state(cfg["statePath"])
        last = state.get("lastReportedTag")
        if not dry_run and not is_newer(newest, last):
            log("nothing-new", newest)
            return 0
        report = build_report(git, cfg, newest, last)
        if dry_run:
            out(f"{report.title}\n\n{report.message}")
            log("dry-run", f"{newest} conflicts={len(report.conflicts)}")
            return 0
        thread_id = start_report_thread(runner, cfg, report)
        # State moves only after the thread exists, so a failed start retries on the next run.
        save_state(
            cfg["statePath"],
            {
                **state,
                "lastReportedTag": newest,
                "reportedAt": now().astimezone(timezone.utc).isoformat(),
                "reportThreadId": thread_id,
            },
        )
        log("reported", f"{newest} thread={thread_id} conflicts={len(report.conflicts)}")
        return 0
    except (WatchError, OSError) as e:
        log("error", str(e))
        return 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--config", required=True, help="path to the watcher config JSON")
    ap.add_argument("--dry-run", action="store_true", help="print the report; start nothing")
    args = ap.parse_args(argv)
    try:
        cfg = load_config(args.config)
    except ConfigError as e:
        if sys.stderr:  # None under pythonw
            print(e, file=sys.stderr)
        return 2
    return run(cfg, dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
