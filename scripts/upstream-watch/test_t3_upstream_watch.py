"""Tests for t3_upstream_watch. Stdlib unittest (no installs needed); pytest collects them too."""

import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
import unittest.mock
from contextlib import redirect_stdout
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import t3_upstream_watch as w  # noqa: E402

TAGS = [
    "v0.1.9",
    "v0.1.10",
    "v0.1.13",
    "v0.1.14-nightly.20261127.5332",
    "v0.1.14-preview.1",
    "release-candidate",
]
AREA_RULES = {
    "apps/server/src/": "server",
    "apps/server/src/orchestration-v2/": "orchestration",
    "apps/web/src/": "web",
}
CONFLICTS = [
    "apps/server/src/orchestration-v2/Orchestrator.ts",
    "apps/server/src/orchestration-v2/Projector.ts",
    "apps/server/src/mcp/tools.ts",
    "apps/web/src/App.tsx",
    "README.md",
]
NOW = datetime(2026, 11, 27, 12, 0, tzinfo=timezone.utc)
TAG_SHA = "a" * 40
FORK_SHA = "b" * 40
TITLE = "T3 Code: upstream v0.1.13 ready, merge?"
START_TAIL = ["--provider", "claude", "--model", "haiku", "--json", "project-1", "-"]
OK_START = (0, '{"threadId": "thread-1"}', "")


def make_config(d, **overrides):
    t3 = os.path.join(d, "bin", "t3.cmd")
    os.makedirs(os.path.dirname(t3), exist_ok=True)
    open(t3, "w").close()
    raw = {
        "mirrorPath": os.path.join(d, "mirror.git"),
        "upstreamUrl": "https://example.invalid/upstream.git",
        "forkRemote": "https://example.invalid/fork.git",
        "forkBranch": "main",
        "projectId": "project-1",
        "reportProvider": "claude",
        "reportModel": "haiku",
        "statePath": os.path.join(d, "state", "state.json"),
        "logPath": os.path.join(d, "state", "watch.log"),
        "areaRules": AREA_RULES,
        "t3Command": [t3],
    }
    return w.validate_config(raw | overrides)


class FakeRunner:
    """Answers only the exact git and t3 argv the watcher should send; records every call.

    `start` is the reply to `t3 thread start`; `creates` says whether the server made the thread
    anyway (a lost reply). `threads` is what `t3 thread list` returns.
    """

    def __init__(self, cfg, tags=TAGS, conflicts=CONFLICTS, start=OK_START, creates=None,
                 marked=True, tag_sha=TAG_SHA, list_reply=None, on_start=None):
        self.cfg, self.tags, self.conflicts, self.start = cfg, tags, conflicts, start
        self.creates = start[0] == 0 if creates is None else creates
        self.marked, self.tag_sha = marked, tag_sha
        self.list_reply, self.on_start = list_reply, on_start
        self.threads = []
        self.calls = []
        self.unexpected = []

    def __call__(self, argv, stdin=None, timeout=None, env=None):
        self.calls.append((argv, stdin))
        if timeout != self.cfg["commandTimeoutSec"]:
            return self.reject(argv, f"timeout={timeout}")
        if argv[0] == self.cfg["t3Command"][0]:
            return self.t3(argv, stdin)
        prefix = ["git", "-c", "core.quotePath=false", "--git-dir", self.cfg["mirrorPath"]]
        if argv[:5] != prefix or env != w.GIT_ENV:
            return self.reject(argv, f"env={env}")
        reply = self.git_replies().get(tuple(argv[5:]))
        return reply() if reply else self.reject(argv)

    def git_replies(self):
        c, m = self.cfg, w.MIRROR_MARKER
        body = "".join(f"{f}\n" for f in self.conflicts)
        replies = {
            ("init", "--bare", "--quiet", c["mirrorPath"]): lambda: w.Result(0, ""),
            ("config", m, "true"): lambda: w.Result(0, ""),
            ("config", "--get", m): lambda: w.Result(0 if self.marked else 1, "true\n" * self.marked),
            ("fetch", "--quiet", "--no-tags", "--force", "--prune", c["upstreamUrl"],
             "+refs/tags/*:refs/tags/*"): lambda: w.Result(0, ""),
            ("fetch", "--quiet", "--no-tags", "--force", c["forkRemote"],
             "+refs/heads/main:refs/watch/fork"): lambda: w.Result(0, ""),
            ("tag", "--list"): lambda: w.Result(0, "\n".join(self.tags) + "\n"),
            ("rev-parse", w.FORK_REF): lambda: w.Result(0, FORK_SHA + "\n"),
            ("rev-list", "--count", f"{FORK_SHA}..{self.tag_sha}"): lambda: w.Result(0, "2379\n"),
            ("rev-list", "--count", "--no-merges", f"{self.tag_sha}..{FORK_SHA}"):
                lambda: w.Result(0, "7\n"),
            ("merge-tree", "--write-tree", "--name-only", "--no-messages", FORK_SHA, self.tag_sha):
                lambda: w.Result(1 if self.conflicts else 0, "c" * 40 + "\n" + body),
        }
        for t in self.tags:
            replies[("rev-parse", f"refs/tags/{t}^{{commit}}")] = lambda: w.Result(0, self.tag_sha)
        return replies

    def t3(self, argv, stdin):
        args = argv[1:]
        if args == ["thread", "list", "--project", "project-1", "--json"]:
            return self.list_reply or w.Result(0, json.dumps(self.threads))
        if args[:3] == ["thread", "start", "--title"] and args[4:] == START_TAIL and stdin:
            if self.on_start:
                self.on_start()
            if self.creates:
                self.threads.insert(0, {"threadId": f"thread-{len(self.threads) + 1}",
                                        "title": args[3], "status": "idle"})
            return w.Result(*self.start)
        return self.reject(argv)

    def reject(self, argv, why=""):
        self.unexpected.append((argv, why))
        raise AssertionError(f"unexpected call {argv} {why}")

    def subcommands(self):
        return [a[1] if a[0] == self.cfg["t3Command"][0] else a[5] for a, _ in self.calls]

    def thread_starts(self):
        return [(a, stdin) for a, stdin in self.calls if a[1:3] == ["thread", "start"]]


class WatcherCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.cfg = make_config(self.dir.name)
        os.makedirs(self.cfg["mirrorPath"])
        open(os.path.join(self.cfg["mirrorPath"], "HEAD"), "w").close()

    def run_watch(self, runner, **kw):
        rc = w.run(self.cfg, runner, now=lambda: NOW, **kw)
        self.assertEqual(getattr(runner, "unexpected", []), [])
        return rc

    def state(self):
        with open(self.cfg["statePath"], encoding="utf-8") as f:
            return json.load(f)

    def statuses(self):
        with open(self.cfg["logPath"], encoding="utf-8") as f:
            return [line.split(" ", 2)[1] for line in f.read().splitlines()]

    def last_log(self):
        with open(self.cfg["logPath"], encoding="utf-8") as f:
            return f.read().splitlines()[-1]


class PureLogicTest(unittest.TestCase):
    def test_tag_pick_per_channel(self):
        self.assertEqual(w.pick_newest(TAGS, w.STABLE_PATTERN), "v0.1.13")
        nightly = r"^v\d+\.\d+\.\d+-nightly\."
        self.assertEqual(w.pick_newest(TAGS, nightly), "v0.1.14-nightly.20261127.5332")
        numbered = ["v0.1.14-nightly.20261127.9", "v0.1.14-nightly.20261127.10"]
        self.assertEqual(w.pick_newest(numbered, nightly), "v0.1.14-nightly.20261127.10")
        self.assertEqual(w.pick_newest(TAGS, r"^v.*"), "v0.1.14-preview.1")
        self.assertIsNone(w.pick_newest(["release-candidate"], w.STABLE_PATTERN))

    def test_is_newer(self):
        self.assertTrue(w.is_newer("v0.1.13", None))
        self.assertTrue(w.is_newer("v0.1.13", "v0.1.9"))
        self.assertFalse(w.is_newer("v0.1.13", "v0.1.13"))
        self.assertFalse(w.is_newer("v0.1.12", "v0.1.13"))
        self.assertTrue(w.is_newer("v0.1.14", "v0.1.14-nightly.1"))

    def test_report_due(self):
        reported = {"lastReportedTag": "v0.1.13", "reported": {"v0.1.13": "a"}}
        for tag, sha, state, want in [
            ("v0.1.13", "a", {}, "new"),
            ("v0.1.13", "a", reported, None),
            ("v0.1.13", "b", reported, "repushed"),
            ("v0.1.14", "c", reported, "new"),
            ("v0.1.12", "d", reported, None),
            ("v0.1.13", "b", {"lastReportedTag": "v0.1.13"}, None),
        ]:
            self.assertEqual(w.report_due(tag, sha, state), want, (tag, sha, state))

    def test_area_grouping_longest_prefix_wins(self):
        self.assertEqual(
            w.group_by_area(CONFLICTS, AREA_RULES),
            [("orchestration", 2), ("other", 1), ("server", 1), ("web", 1)],
        )

    def test_merge_tree_parsing(self):
        self.assertEqual(w.parse_merge_tree(w.Result(0, "c" * 40 + "\n")), [])
        out = "c" * 40 + "\napps/a.ts\napps/b.ts\n\nAuto-merging apps/a.ts\n"
        self.assertEqual(w.parse_merge_tree(w.Result(1, out)), ["apps/a.ts", "apps/b.ts"])
        with self.assertRaisesRegex(w.WatchError, "merge-tree failed"):
            w.parse_merge_tree(w.Result(128, "", "fatal: bad object"))


class ConfigTest(unittest.TestCase):
    def test_missing_key_is_named(self):
        with self.assertRaisesRegex(w.ConfigError, "missing required key.*projectId.*areaRules"):
            w.validate_config({"mirrorPath": "m", "projectId": ""})

    def test_bad_values_are_explained(self):
        base = {k: "x" for k in w.REQUIRED_KEYS} | {"areaRules": {}, "t3Command": ["t3"]}
        with self.assertRaisesRegex(w.ConfigError, "channelPattern"):
            w.validate_config(base | {"channelPattern": "("})
        with self.assertRaisesRegex(w.ConfigError, "t3Command"):
            w.validate_config(base | {"t3Command": "t3"})
        with self.assertRaisesRegex(w.ConfigError, "areaRules"):
            w.validate_config(base | {"areaRules": ["apps/"]})
        with self.assertRaisesRegex(w.ConfigError, "maxStartAttempts"):
            w.validate_config(base | {"maxStartAttempts": 0})
        self.assertEqual(w.validate_config(base)["channelPattern"], w.STABLE_PATTERN)

    def test_t3_command_resolution(self):
        with tempfile.TemporaryDirectory() as d:
            shim = os.path.join(d, "t3.cmd")
            open(shim, "w").close()
            self.assertEqual(w.resolve_command([shim, "-x"]), [shim, "-x"])
            self.assertEqual(w.resolve_command(["t3", "-x"], lambda name: shim), [shim, "-x"])
            with self.assertRaisesRegex(w.ConfigError, "not on PATH; set an absolute path"):
                w.resolve_command(["t3"], lambda name: None)
            with self.assertRaisesRegex(w.ConfigError, "does not exist"):
                w.resolve_command([os.path.join(d, "missing.cmd")])

    def test_main_logs_config_errors_without_a_console(self):
        with tempfile.TemporaryDirectory() as d:
            log = os.path.join(d, "watch.log")
            bom = os.path.join(d, "bom.json")
            with open(bom, "w", encoding="utf-8-sig") as f:
                json.dump({"logPath": log}, f)
            unreadable = os.path.join(d, "broken.json")
            with open(unreadable, "w", encoding="utf-8") as f:
                f.write("{")
            with unittest.mock.patch("sys.stderr", None), redirect_stdout(io.StringIO()):
                self.assertEqual(w.main(["--config", bom]), 2)
                self.assertEqual(w.main(["--config", unreadable]), 2)
            with open(log, encoding="utf-8") as f:
                self.assertIn("missing required key", f.read())
            with open(unreadable + ".error.log", encoding="utf-8") as f:
                self.assertIn("cannot read config", f.read())


class RunHiddenTest(unittest.TestCase):
    def fake_popen(self, communicate):
        proc = unittest.mock.Mock(pid=4242, returncode=0)
        proc.communicate.side_effect = communicate
        return unittest.mock.patch.object(w.subprocess, "Popen", return_value=proc), proc

    def test_runs_without_a_window_and_with_git_env(self):
        patch, _ = self.fake_popen([("out", "err")])
        with patch as popen:
            self.assertEqual(w.run_hidden(["git", "x"], env=w.GIT_ENV), w.Result(0, "out", "err"))
        kw = popen.call_args.kwargs
        self.assertEqual(kw["creationflags"], 0x08000000 if os.name == "nt" else 0)
        self.assertEqual(kw["stdin"], subprocess.DEVNULL)
        self.assertEqual(kw["env"]["GIT_TERMINAL_PROMPT"], "0")
        self.assertEqual(kw["env"]["GCM_INTERACTIVE"], "never")
        self.assertIn("PATH", {k.upper() for k in kw["env"]})

    def test_timeout_kills_the_tree_and_does_not_wait_on_held_pipes(self):
        expired = subprocess.TimeoutExpired("t3", 1)
        patch, proc = self.fake_popen([expired, expired])
        with patch, unittest.mock.patch.object(w.subprocess, "run") as taskkill:
            r = w.run_hidden(["t3", "thread"], stdin="hi", timeout=1)
        self.assertEqual(r.code, 124)
        proc.kill.assert_called_once()
        if os.name == "nt":
            argv = taskkill.call_args.args[0]
            self.assertTrue(argv[0].lower().endswith("taskkill.exe"))
            self.assertEqual(argv[1:], ["/T", "/F", "/PID", "4242"])
            self.assertEqual(taskkill.call_args.kwargs["creationflags"], 0x08000000)

    def test_real_child_gets_stdin_and_times_out(self):
        echo = [sys.executable, "-I", "-c", "import sys; print(sys.stdin.read().upper())"]
        self.assertEqual(w.run_hidden(echo, stdin="hi"), w.Result(0, "HI\n", ""))
        sleeper = [sys.executable, "-I", "-c", "import time; time.sleep(60)"]
        self.assertEqual(w.run_hidden(sleeper, timeout=0.5).code, 124)


class RunTest(WatcherCase):
    def test_new_tag_starts_one_report_thread_then_nothing(self):
        runner = FakeRunner(self.cfg)
        self.assertEqual(self.run_watch(runner), 0)
        [(argv, message)] = runner.thread_starts()
        t3 = self.cfg["t3Command"][0]
        self.assertEqual(argv, [t3, "thread", "start", "--title", TITLE, *START_TAIL])
        for text in (
            "Upstream released v0.1.13 (aaaaaaaaaa). Last reported: none.",
            "fork branch main (bbbbbbbbbb)",
            "Upstream commits not in the fork: 2379",
            "Fork-only commits (non-merge): 7",
            "Conflicted files (git merge-tree): 5",
            "  - orchestration: 2",
            '"Reply OK to open the merge thread."',
            "Do not merge, push, or start any thread or worktree unless Maxi replies OK.",
        ):
            self.assertIn(text, message)
        state = self.state()
        self.assertEqual(state["reported"], {"v0.1.13": TAG_SHA})
        self.assertEqual(state["reportThreadId"], "thread-1")
        self.assertNotIn("pending", state)

        again = FakeRunner(self.cfg)
        self.assertEqual(self.run_watch(again), 0)
        self.assertEqual(again.thread_starts(), [])
        self.assertNotIn("merge-tree", again.subcommands())
        self.assertEqual(self.statuses(), ["reported", "nothing-new"])
        self.assertFalse(os.path.exists(self.cfg["statePath"] + ".lock"))

    def test_no_new_tag_writes_no_state(self):
        reported = {"lastReportedTag": "v0.1.13", "reported": {"v0.1.13": TAG_SHA}}
        w.save_state(self.cfg["statePath"], reported)
        before = os.stat(self.cfg["statePath"]).st_mtime_ns
        runner = FakeRunner(self.cfg)
        self.assertEqual(self.run_watch(runner), 0)
        self.assertEqual(runner.subcommands(), ["config", "fetch", "fetch", "tag", "rev-parse"])
        self.assertEqual(os.stat(self.cfg["statePath"]).st_mtime_ns, before)

    def test_pending_is_saved_before_the_thread_starts(self):
        seen = []
        runner = FakeRunner(self.cfg, on_start=lambda: seen.append(self.state().get("pending")))
        self.assertEqual(self.run_watch(runner), 0)
        [pending] = seen
        self.assertEqual([pending[k] for k in ("tag", "sha", "attempts")], ["v0.1.13", TAG_SHA, 1])
        self.assertEqual(pending["title"], TITLE)

    def test_lost_reply_is_adopted_so_three_runs_make_one_thread(self):
        runner = FakeRunner(self.cfg, start=(1, "", "socket hang up"), creates=True)
        self.assertEqual(self.run_watch(runner), 1)
        self.assertEqual(self.run_watch(runner), 0)
        self.assertEqual(self.run_watch(runner), 0)
        self.assertEqual(len(runner.thread_starts()), 1)
        self.assertEqual(len(runner.threads), 1)
        self.assertEqual(self.statuses(), ["error", "adopted", "nothing-new"])
        self.assertEqual(self.state()["reportThreadId"], "thread-1")
        self.assertNotIn("pending", self.state())

    def test_failed_state_write_after_start_is_adopted(self):
        runner = FakeRunner(self.cfg)
        real_save = w.save_state
        writes = []

        def save_once_then_fail(path, state):
            writes.append(state)
            if len(writes) == 2:
                raise OSError("disk full")
            real_save(path, state)

        with unittest.mock.patch.object(w, "save_state", save_once_then_fail):
            self.assertEqual(self.run_watch(runner), 1)
        self.assertIn("disk full", self.last_log())
        self.assertEqual(self.run_watch(runner), 0)
        self.assertEqual(len(runner.thread_starts()), 1)
        self.assertEqual(self.statuses(), ["error", "adopted"])

    def test_failed_start_retries_until_the_attempt_cap(self):
        self.cfg["maxStartAttempts"] = 2
        runner = FakeRunner(self.cfg, start=(1, "", "Traceback:\n  error: server not reachable\n"))
        self.assertEqual(self.run_watch(runner), 1)
        self.assertIn("t3 thread start failed (1): Traceback: error: server not reachable", self.last_log())
        self.assertEqual(self.state()["pending"]["attempts"], 1)
        self.assertEqual(self.run_watch(runner), 1)
        self.assertEqual(self.run_watch(runner), 1)
        self.assertEqual(len(runner.thread_starts()), 2)
        self.assertIn("gave up on v0.1.13 after 2 start attempts", self.last_log())

        runner.start, runner.creates = OK_START, True
        state = self.state()
        del state["pending"]
        w.save_state(self.cfg["statePath"], state)
        self.assertEqual(self.run_watch(runner), 0)
        self.assertEqual(self.state()["reported"], {"v0.1.13": TAG_SHA})

    def test_unreadable_thread_list_never_starts_blind(self):
        w.save_state(self.cfg["statePath"], {"pending": {"tag": "v0.1.13", "sha": TAG_SHA, "attempts": 1}})
        runner = FakeRunner(self.cfg, list_reply=w.Result(1, "", "server down"))
        self.assertEqual(self.run_watch(runner), 1)
        self.assertEqual(runner.thread_starts(), [])
        self.assertIn("t3 thread list failed (1): server down", self.last_log())

    def test_overlapping_run_is_refused_and_a_stale_lock_is_taken_over(self):
        lock = self.cfg["statePath"] + ".lock"
        os.makedirs(os.path.dirname(lock), exist_ok=True)
        with open(lock, "w") as f:
            f.write("other run")
        runner = FakeRunner(self.cfg)
        self.assertEqual(self.run_watch(runner), 0)
        self.assertEqual(runner.calls, [])
        self.assertEqual(self.statuses(), ["busy"])

        old = time.time() - self.cfg["lockStaleSec"] - 60
        os.utime(lock, (old, old))
        self.assertEqual(self.run_watch(runner), 0)
        self.assertEqual(len(runner.thread_starts()), 1)
        self.assertFalse(os.path.exists(lock))

    def test_repushed_tag_is_reported_once(self):
        w.save_state(self.cfg["statePath"], {"lastReportedTag": "v0.1.13", "reported": {"v0.1.13": "f" * 40}})
        runner = FakeRunner(self.cfg)
        self.assertEqual(self.run_watch(runner), 0)
        self.assertEqual(self.run_watch(runner), 0)
        [(argv, message)] = runner.thread_starts()
        self.assertEqual(argv[4], "T3 Code: upstream v0.1.13 re-pushed (aaaaaaaaaa), merge?")
        self.assertIn("Upstream re-pushed (the tag moved to a new commit) v0.1.13", message)
        self.assertEqual(self.state()["reported"], {"v0.1.13": TAG_SHA})

    def test_dry_run_prints_report_and_starts_nothing(self):
        w.save_state(self.cfg["statePath"], {"lastReportedTag": "v0.1.13"})
        runner = FakeRunner(self.cfg, conflicts=[])
        printed = []
        self.assertEqual(self.run_watch(runner, dry_run=True, out=printed.append), 0)
        self.assertEqual(runner.thread_starts(), [])
        self.assertIn(TITLE, printed[0])
        self.assertIn("Conflicted files (git merge-tree): 0", printed[0])
        self.assertEqual(self.state(), {"lastReportedTag": "v0.1.13"})

    def test_missing_mirror_is_created_marked_and_fetched_with_prune(self):
        os.remove(os.path.join(self.cfg["mirrorPath"], "HEAD"))
        os.rmdir(self.cfg["mirrorPath"])
        runner = FakeRunner(self.cfg, tags=["release-candidate"])
        self.assertEqual(self.run_watch(runner), 0)
        self.assertEqual(runner.subcommands(), ["init", "config", "fetch", "fetch", "tag"])
        self.assertEqual(self.statuses(), ["no-tag"])

    def test_unmarked_folder_is_never_used_as_mirror(self):
        runner = FakeRunner(self.cfg, marked=False)
        self.assertEqual(self.run_watch(runner), 1)
        self.assertEqual(runner.subcommands(), ["config"])
        self.assertIn("is not a watcher mirror", self.last_log())

    def test_git_failure_is_logged_and_writes_no_state(self):
        runner = FakeRunner(self.cfg)

        def offline(argv, stdin=None, timeout=None, env=None):
            if argv[5] == "fetch":
                return w.Result(128, "", "fatal: unable to access")
            return runner(argv, stdin, timeout, env)

        self.assertEqual(self.run_watch(offline), 1)
        self.assertFalse(os.path.exists(self.cfg["statePath"]))
        self.assertIn("git fetch failed (128): fatal: unable to access", self.last_log())

    def test_unexpected_exception_is_logged(self):
        def broken(argv, stdin=None, timeout=None, env=None):
            raise RuntimeError("boom")

        self.assertEqual(self.run_watch(broken), 1)
        self.assertIn("error RuntimeError: boom", self.last_log())
        self.assertFalse(os.path.exists(self.cfg["statePath"] + ".lock"))


def git(*args, stdin=""):
    r = subprocess.run(["git", *args], input=stdin, capture_output=True, text=True,
                       creationflags=w.hidden_flags(), check=True)
    return r.stdout.strip()


@unittest.mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"})
class RealGitTest(unittest.TestCase):
    """Real git against a local bare "upstream" (no network); only t3 is faked."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        d = self.dir.name
        self.up = os.path.join(d, "upstream.git")
        git("init", "--bare", "--quiet", self.up)
        self.cfg = make_config(d, upstreamUrl=self.up, forkRemote=self.up)
        self.c1 = self.commit("c1")
        self.c2 = self.commit("c2", self.c1)
        self.up_git("update-ref", "refs/heads/main", self.c2)
        self.up_git("update-ref", "refs/tags/v0.1.0", self.c1)
        self.up_git("tag", "-a", "-m", "release", "v0.1.1", self.c2)

    def up_git(self, *args, stdin=""):
        return git("--git-dir", self.up, *args, stdin=stdin)

    def commit(self, msg, parent=None):
        tree = self.up_git("mktree")
        extra = ["-p", parent] if parent else []
        return self.up_git("-c", "user.name=t", "-c", "user.email=t@example.invalid",
                           "commit-tree", tree, "-m", msg, *extra)

    def run_watch(self):
        starts = self.starts

        def runner(argv, stdin=None, timeout=None, env=None):
            if argv[0] != self.cfg["t3Command"][0]:
                return w.run_hidden(argv, stdin, timeout, env)
            starts.append(argv[4])
            return w.Result(0, json.dumps({"threadId": f"thread-{len(starts)}"}))

        return w.run(self.cfg, runner, now=lambda: NOW)

    def test_prune_and_repushed_tag_with_a_real_mirror(self):
        self.starts = []
        self.assertEqual(self.run_watch(), 0)
        self.assertEqual(self.starts, ["T3 Code: upstream v0.1.1 ready, merge?"])
        mirror = ["--git-dir", self.cfg["mirrorPath"]]
        self.assertEqual(git(*mirror, "config", "--get", w.MIRROR_MARKER), "true")

        self.up_git("update-ref", "-d", "refs/tags/v0.1.1")
        self.assertEqual(self.run_watch(), 0)
        self.assertEqual(git(*mirror, "tag", "--list").split(), ["v0.1.0"])

        c3 = self.commit("c3", self.c2)
        self.up_git("update-ref", "refs/tags/v0.1.1", c3)
        self.assertEqual(self.run_watch(), 0)
        self.assertEqual(self.run_watch(), 0)
        self.assertEqual(self.starts[1:], [f"T3 Code: upstream v0.1.1 re-pushed ({c3[:10]}), merge?"])
        with open(self.cfg["statePath"], encoding="utf-8") as f:
            self.assertEqual(json.load(f)["reported"], {"v0.1.1": c3})

    def test_existing_repo_is_not_overwritten(self):
        self.starts = []
        self.cfg["mirrorPath"] = self.up
        self.assertEqual(self.run_watch(), 1)
        self.assertEqual(self.starts, [])
        with open(self.cfg["logPath"], encoding="utf-8") as f:
            self.assertIn("is not a watcher mirror", f.read())


if __name__ == "__main__":
    unittest.main()
