"""Upstream release watcher for the T3 Code fork (plan item 4.1, Part A).

Run: pythonw t3_upstream_watch.py --config <path> [--dry-run]
Checks the newest upstream tag on the configured channel. Nothing new: one log line, exit 0.
New tag (or a reported tag re-pushed to a new commit): counts commits and merge conflicts, then
starts one T3 report thread that asks Maxi for an OK. It never merges, pushes, or opens a merge
thread itself. One run at a time (OS lock on a file next to the state file, freed if the run dies);
the pending report is saved before the thread starts, so after a lost reply the next run adopts the
thread (by its saved title, or by the brief's marker line if it was renamed) instead of re-sending.

Config: see config.example.json. Pin t3Command to an absolute path (`where t3` on Windows gives the
npm t3.cmd shim); a bare name is resolved through PATH/PATHEXT at run time. mirrorPath must be a
folder this script created (it marks the bare repo with upstreamWatch.mirror=true). After
maxStartAttempts failed starts for one tag it stops and logs; delete "pending" in the state file to
retry. Errors, including config errors, go to logPath (or <config>.error.log if it is unreadable).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
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
DEFAULTS = {
    "channelPattern": STABLE_PATTERN,
    "commandTimeoutSec": 600,
    "maxStartAttempts": 3,
}
PATH_KEYS = ("mirrorPath", "statePath", "logPath")
FORK_REF = "refs/watch/fork"
MIRROR_MARKER = "upstreamWatch.mirror"
OTHER_AREA = "other"
TITLE = "T3 Code: upstream {tag} ready, merge?"
TITLE_REPUSHED = "T3 Code: upstream {tag} re-pushed ({sha}), merge?"
# Stable line in the brief so a renamed report thread can still be adopted.
MARKER = "Watcher report id: {tag}@{sha}"
# Server and watcher clocks may differ slightly when matching createdAt to pending.since.
ADOPT_CLOCK_SKEW = timedelta(minutes=5)
# Report threads stay short; the brief must be among this many latest messages to be found.
ADOPT_SHOW_MESSAGES = 50
# Scheduled runs have nobody to answer a credential prompt or dialog.
GIT_ENV = {"GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"}
KILL_GRACE_SEC = 10
VERSION_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$")


class WatchError(Exception):
    pass


class ConfigError(WatchError):
    pass


class LockBusy(WatchError):
    pass


@dataclass(frozen=True)
class Result:
    code: int
    out: str
    err: str = ""


Runner = Callable[..., Result]


def hidden_flags() -> int:
    return subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def kill_tree(p: subprocess.Popen) -> None:
    if os.name == "nt":
        root = os.environ.get("SystemRoot", r"C:\Windows")
        try:
            subprocess.run(
                [os.path.join(root, "System32", "taskkill.exe"), "/T", "/F", "/PID", str(p.pid)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=hidden_flags(),
                timeout=KILL_GRACE_SEC,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass
    p.kill()


def run_hidden(
    argv: list[str],
    stdin: str | None = None,
    timeout: float | None = None,
    env: dict | None = None,
) -> Result:
    try:
        p = subprocess.Popen(
            argv,
            stdin=subprocess.DEVNULL if stdin is None else subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=hidden_flags(),
            env={**os.environ, **env} if env else None,
        )
    except OSError as e:
        return Result(127, "", f"cannot run {argv[0]}: {e}")
    try:
        out, err = p.communicate(stdin, timeout=timeout)
    except subprocess.TimeoutExpired:
        kill_tree(p)
        try:
            p.communicate(timeout=KILL_GRACE_SEC)
        except subprocess.TimeoutExpired:
            pass  # a surviving grandchild holds the pipes; the reader threads are daemons
        return Result(124, "", f"timed out after {timeout}s: {argv[0]}")
    return Result(p.returncode, out, err)


def resolve_command(cmd: list[str], which: Callable[[str], str | None] = shutil.which) -> list[str]:
    # CreateProcess cannot find the npm `t3.cmd` shim by bare name; which() applies PATHEXT.
    exe = cmd[0]
    if os.path.isabs(exe):
        if not os.path.isfile(exe):
            raise ConfigError(f"t3Command {exe} does not exist")
        return list(cmd)
    found = which(exe)
    if not found:
        raise ConfigError(f"t3Command {exe!r} is not on PATH; set an absolute path")
    return [found, *cmd[1:]]


# --- config and state -------------------------------------------------------


def load_config(path: str) -> dict:
    try:
        with open(path, encoding="utf-8-sig") as f:
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
    for k in ("commandTimeoutSec", "maxStartAttempts"):
        if not isinstance(cfg[k], int) or isinstance(cfg[k], bool) or cfg[k] < 1:
            raise ConfigError(f"{source}: {k} must be a positive integer")
    try:
        re.compile(cfg["channelPattern"])
    except re.error as e:
        raise ConfigError(f"{source}: channelPattern is not a valid regex: {e}") from e
    for k in PATH_KEYS:
        cfg[k] = os.path.expanduser(cfg[k])
    return cfg


def load_state(path: str) -> dict:
    try:
        with open(path, encoding="utf-8-sig") as f:
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


@contextmanager
def run_lock(path: str):
    # An OS lock, not an existence check: it is freed when the holder dies, so there is no stale
    # lock to take over and no takeover race. The file stays; deleting it would reopen a race.
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT)
    try:
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise LockBusy(f"another run holds {path}") from None
        yield
    finally:
        os.close(fd)


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


def report_due(tag: str, sha: str, state: dict) -> str | None:
    """"new", "repushed" (a reported tag now points at another commit), or None."""
    reported = state.get("reported") or {}
    last = state.get("lastReportedTag")
    if tag in reported:
        return "repushed" if reported[tag] != sha else None
    if tag == last:  # state written before tag SHAs were stored
        return None
    return "new" if is_newer(tag, last) else None


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
    repushed: bool = False

    @property
    def title(self) -> str:
        if self.repushed:
            return TITLE_REPUSHED.format(tag=self.tag, sha=self.tag_sha[:10])
        return TITLE.format(tag=self.tag)

    @property
    def marker(self) -> str:
        return MARKER.format(tag=self.tag, sha=self.tag_sha)

    @property
    def message(self) -> str:
        verb = "re-pushed (the tag moved to a new commit)" if self.repushed else "released"
        lines = [
            f"Upstream {verb} {self.tag} ({self.tag_sha[:10]}). "
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
            "Do not rename this thread.",
            "",
            self.marker,
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
        return self.runner(argv, timeout=self.timeout, env=GIT_ENV)

    def __call__(self, *args: str) -> str:
        r = self.raw(*args)
        if r.code != 0:
            raise WatchError(f"git {args[0]} failed ({r.code}): {r.err.strip()}")
        return r.out


def refresh_mirror(git: Git, cfg: dict) -> None:
    # Bare repo with only tags + the fork branch; `clone --mirror` of GitHub pulls every PR ref too.
    mirror = cfg["mirrorPath"]
    if not os.path.isdir(mirror) or not os.listdir(mirror):
        git("init", "--bare", "--quiet", mirror)
        git("config", MIRROR_MARKER, "true")
    elif git.raw("config", "--get", MIRROR_MARKER).out.strip() != "true":
        # Fetching force-overwrites and prunes tags: never adopt a folder this script did not make.
        raise WatchError(f"{mirror} is not a watcher mirror (no {MIRROR_MARKER}); refusing")
    git(
        "fetch",
        "--quiet",
        "--no-tags",
        "--force",
        "--prune",
        cfg["upstreamUrl"],
        "+refs/tags/*:refs/tags/*",
    )
    git(
        "fetch",
        "--quiet",
        "--no-tags",
        "--force",
        cfg["forkRemote"],
        f"+refs/heads/{cfg['forkBranch']}:{FORK_REF}",
    )


def tag_commit(git: Git, tag: str) -> str:
    # Peeled commit id: upstream tags may be annotated, and every count must use the same commits.
    return git("rev-parse", f"refs/tags/{tag}^{{commit}}").strip()


def build_report(
    git: Git, cfg: dict, tag: str, tag_sha: str, previous: str | None, repushed: bool = False
) -> Report:
    fork_sha = git("rev-parse", FORK_REF).strip()
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
        repushed=repushed,
    )


def t3_json(runner: Runner, cfg: dict, argv: list[str], what: str):
    r = runner(argv, timeout=cfg["commandTimeoutSec"])
    if r.code != 0:
        raise WatchError(f"{what} failed ({r.code}): {r.err.strip()[-300:]}")
    try:
        return json.loads(r.out)
    except ValueError as e:
        raise WatchError(f"{what} printed no JSON: {e}") from e


def parse_time(value: object) -> datetime | None:
    try:
        t = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else None


def find_thread(runner: Runner, t3: list[str], cfg: dict, pending: dict) -> str | None:
    """The thread a pending start made: by its saved title or, if renamed, by the brief's marker."""
    argv = [*t3, "thread", "list", "--project", cfg["projectId"], "--json"]
    listed = t3_json(runner, cfg, argv, "t3 thread list")
    threads = [t for t in listed if isinstance(t, dict)] if isinstance(listed, list) else []
    for t in threads:
        if t.get("title") == pending.get("title"):
            return str(t.get("threadId"))
    since, marker = parse_time(pending.get("since")), pending.get("marker")
    if since is None or not marker:
        return None
    report_model = (cfg["reportProvider"], cfg["reportModel"])
    for t in threads:
        created = parse_time(t.get("createdAt"))
        if created is None or created < since - ADOPT_CLOCK_SKEW:
            continue
        if (t.get("providerInstanceId"), t.get("model")) != report_model:
            continue
        tid = str(t.get("threadId"))
        argv = [*t3, "thread", "show", tid, "--messages", str(ADOPT_SHOW_MESSAGES), "--json"]
        shown = t3_json(runner, cfg, argv, "t3 thread show")
        messages = shown.get("messages") if isinstance(shown, dict) else None
        for m in messages if isinstance(messages, list) else []:
            if isinstance(m, dict) and m.get("role") == "user" and marker in str(m.get("text")):
                return tid
    return None


def start_report_thread(runner: Runner, t3: list[str], cfg: dict, report: Report) -> str | None:
    argv = [
        *t3,
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


def mark_reported(cfg: dict, state: dict, tag: str, sha: str, thread_id: str | None, at: datetime):
    rest = {k: v for k, v in state.items() if k != "pending"}
    save_state(
        cfg["statePath"],
        {
            **rest,
            "lastReportedTag": tag,
            "reported": {**(state.get("reported") or {}), tag: sha},
            "reportedAt": at.astimezone(timezone.utc).isoformat(),
            "reportThreadId": thread_id,
        },
    )


def run_locked(
    cfg: dict, runner: Runner, t3: list[str] | None, dry_run: bool, now, out, log
) -> int:
    git = Git(runner, cfg)
    refresh_mirror(git, cfg)
    newest = pick_newest(git("tag", "--list").split(), cfg["channelPattern"])
    if newest is None:
        log("no-tag", f"nothing matches {cfg['channelPattern']}")
        return 0
    tag_sha = tag_commit(git, newest)
    state = load_state(cfg["statePath"])
    due = report_due(newest, tag_sha, state)
    if not dry_run and due is None:
        log("nothing-new", newest)
        return 0
    last = state.get("lastReportedTag")
    report = build_report(git, cfg, newest, tag_sha, last, repushed=due == "repushed")
    if dry_run or t3 is None:
        out(f"{report.title}\n\n{report.message}")
        log("dry-run", f"{newest} conflicts={len(report.conflicts)}")
        return 0
    pending = state.get("pending")
    attempts = 0
    if isinstance(pending, dict) and pending.get("tag") and pending.get("sha"):
        # The last start may have created the thread even though its reply or state write was lost.
        # Look even if the tag moved since; the next run then reports the move as a re-push.
        thread_id = find_thread(runner, t3, cfg, pending)
        if thread_id is not None:
            mark_reported(cfg, state, pending["tag"], pending["sha"], thread_id, now())
            log("adopted", f"{pending['tag']} thread={thread_id}")
            return 0
    if isinstance(pending, dict) and (pending.get("tag"), pending.get("sha")) == (newest, tag_sha):
        attempts = int(pending.get("attempts", 0))
        if attempts >= cfg["maxStartAttempts"]:
            log(
                "error",
                f"gave up on {newest} after {attempts} start attempts; "
                f"delete 'pending' in {cfg['statePath']} to retry",
            )
            return 1
    pending = {
        "tag": newest,
        "sha": tag_sha,
        "title": report.title,
        "marker": report.marker,
        "attempts": attempts + 1,
        "since": now().astimezone(timezone.utc).isoformat(),
    }
    save_state(cfg["statePath"], {**state, "pending": pending})
    thread_id = start_report_thread(runner, t3, cfg, report)
    mark_reported(cfg, state, report.tag, report.tag_sha, thread_id, now())
    log("reported", f"{newest} thread={thread_id} conflicts={len(report.conflicts)}")
    return 0


def run(
    cfg: dict,
    runner: Runner = run_hidden,
    *,
    dry_run: bool = False,
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    out: Callable[[str], None] = print,
    which: Callable[[str], str | None] = shutil.which,
) -> int:
    def log(status: str, detail: str = "") -> None:
        append_log(cfg["logPath"], now(), status, detail)

    try:
        t3 = None if dry_run else resolve_command(cfg["t3Command"], which)
        with run_lock(cfg["statePath"] + ".lock"):
            return run_locked(cfg, runner, t3, dry_run, now, out, log)
    except LockBusy as e:
        log("busy", str(e))
        return 0
    except WatchError as e:
        log("error", str(e))
        return 1
    except Exception as e:  # pythonw has no console: the log is the only place errors show up
        log("error", f"{type(e).__name__}: {e}")
        return 1


def fallback_log_path(config_path: str) -> str:
    try:
        with open(config_path, encoding="utf-8-sig") as f:
            raw = json.load(f)
        if isinstance(raw, dict) and isinstance(raw.get("logPath"), str) and raw["logPath"]:
            return os.path.expanduser(raw["logPath"])
    except (OSError, ValueError):
        pass
    return config_path + ".error.log"


def report_fatal(config_path: str, message: str) -> None:
    if sys.stderr:  # None under pythonw
        print(message, file=sys.stderr)
    try:
        append_log(fallback_log_path(config_path), datetime.now(timezone.utc), "error", message)
    except OSError:
        pass


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--config", required=True, help="path to the watcher config JSON")
    ap.add_argument("--dry-run", action="store_true", help="print the report; start nothing")
    args = ap.parse_args(argv)
    try:
        cfg = load_config(args.config)
    except Exception as e:
        detail = str(e) if isinstance(e, WatchError) else f"{type(e).__name__}: {e}"
        report_fatal(args.config, detail)
        return 2
    try:
        return run(cfg, dry_run=args.dry_run)
    except Exception as e:  # only reachable when the log file itself cannot be written
        report_fatal(args.config, f"{type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
