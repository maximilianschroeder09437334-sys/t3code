"""Tests for t3_upstream_watch. Stdlib unittest (no installs needed); pytest collects them too."""

import io
import json
import os
import sys
import tempfile
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


class FakeRunner:
    """Answers git and t3 argv like the real CLIs; records every call."""

    def __init__(self, tags=TAGS, conflicts=CONFLICTS, start=(0, '{"threadId": "thread-1"}', "")):
        self.tags = tags
        self.conflicts = conflicts
        self.start = start
        self.calls = []

    def __call__(self, argv, stdin=None, timeout=None):
        self.calls.append((argv, stdin))
        if argv[0] == "t3":
            return w.Result(*self.start)
        sub = argv[5]
        if sub == "tag":
            return w.Result(0, "\n".join(self.tags) + "\n")
        if sub == "rev-parse":
            return w.Result(0, "a" * 40 + "\n" + "b" * 40 + "\n")
        if sub == "rev-list":
            return w.Result(0, "7\n" if "--no-merges" in argv else "2379\n")
        if sub == "merge-tree":
            body = "".join(f"{f}\n" for f in self.conflicts)
            return w.Result(1 if self.conflicts else 0, "c" * 40 + "\n" + body)
        return w.Result(0, "")

    def subcommands(self):
        return [a[0] if a[0] == "t3" else a[5] for a, _ in self.calls]

    def thread_starts(self):
        return [(a, stdin) for a, stdin in self.calls if a[0] == "t3"]


class WatcherCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        d = self.dir.name
        os.makedirs(os.path.join(d, "mirror.git"))
        self.cfg = w.validate_config(
            {
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
                "t3Command": ["t3"],
            }
        )

    def run_watch(self, runner, **kw):
        return w.run(self.cfg, runner, now=lambda: NOW, **kw)

    def state(self):
        with open(self.cfg["statePath"], encoding="utf-8") as f:
            return json.load(f)

    def log_lines(self):
        with open(self.cfg["logPath"], encoding="utf-8") as f:
            return f.read().splitlines()


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
        self.assertEqual(w.validate_config(base)["channelPattern"], w.STABLE_PATTERN)

    def test_main_exits_2_on_unreadable_config(self):
        missing = os.path.join(tempfile.gettempdir(), "nope.json")
        with redirect_stdout(io.StringIO()), unittest.mock.patch("sys.stderr", io.StringIO()) as err:
            self.assertEqual(w.main(["--config", missing]), 2)
        self.assertIn("cannot read config", err.getvalue())


class RunTest(WatcherCase):
    def test_new_tag_starts_one_report_thread_then_nothing(self):
        runner = FakeRunner()
        self.assertEqual(self.run_watch(runner), 0)
        [(argv, message)] = runner.thread_starts()
        self.assertEqual(
            argv,
            ["t3", "thread", "start", "project-1", "-"]
            + ["--title", "T3 Code: upstream v0.1.13 ready, merge?"]
            + ["--provider", "claude", "--model", "haiku", "--json"],
        )
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
        self.assertEqual(self.state()["lastReportedTag"], "v0.1.13")
        self.assertEqual(self.state()["reportThreadId"], "thread-1")

        again = FakeRunner()
        self.assertEqual(self.run_watch(again), 0)
        self.assertEqual(again.thread_starts(), [])
        self.assertNotIn("merge-tree", again.subcommands())
        self.assertEqual(
            [line.split(" ", 2)[1] for line in self.log_lines()], ["reported", "nothing-new"]
        )

    def test_no_new_tag_writes_no_state(self):
        w.save_state(self.cfg["statePath"], {"lastReportedTag": "v0.1.13"})
        before = os.stat(self.cfg["statePath"]).st_mtime_ns
        runner = FakeRunner()
        self.assertEqual(self.run_watch(runner), 0)
        self.assertEqual(runner.subcommands(), ["fetch", "fetch", "tag"])
        self.assertEqual(os.stat(self.cfg["statePath"]).st_mtime_ns, before)

    def test_failed_thread_start_keeps_state_and_retries(self):
        failing = FakeRunner(start=(1, "", "Traceback:\n  error: server not reachable\n"))
        self.assertEqual(self.run_watch(failing), 1)
        self.assertFalse(os.path.exists(self.cfg["statePath"]))
        [line] = self.log_lines()
        self.assertIn("t3 thread start failed (1): Traceback: error: server not reachable", line)

        retry = FakeRunner()
        self.assertEqual(self.run_watch(retry), 0)
        self.assertEqual(len(retry.thread_starts()), 1)
        self.assertEqual(self.state()["lastReportedTag"], "v0.1.13")

    def test_dry_run_prints_report_and_starts_nothing(self):
        w.save_state(self.cfg["statePath"], {"lastReportedTag": "v0.1.13"})
        runner = FakeRunner(conflicts=[])
        printed = []
        self.assertEqual(self.run_watch(runner, dry_run=True, out=printed.append), 0)
        self.assertEqual(runner.thread_starts(), [])
        self.assertIn("T3 Code: upstream v0.1.13 ready, merge?", printed[0])
        self.assertIn("Conflicted files (git merge-tree): 0", printed[0])
        self.assertEqual(self.state(), {"lastReportedTag": "v0.1.13"})

    def test_missing_mirror_is_created_and_fetches_only_tags_and_fork_branch(self):
        os.rmdir(self.cfg["mirrorPath"])
        runner = FakeRunner(tags=["release-candidate"])
        self.assertEqual(self.run_watch(runner), 0)
        init, tags, fork = (argv[5:] for argv, _ in runner.calls[:3])
        self.assertEqual(init, ["init", "--bare", "--quiet", self.cfg["mirrorPath"]])
        self.assertEqual(tags[-1], "+refs/tags/*:refs/tags/*")
        fork_src = ["https://example.invalid/fork.git", "+refs/heads/main:refs/watch/fork"]
        self.assertEqual(fork[-2:], fork_src)
        self.assertEqual(self.log_lines()[-1].split(" ", 2)[1], "no-tag")

    def test_git_failure_is_logged_and_writes_no_state(self):
        runner = FakeRunner()
        runner_call = runner.__call__

        def offline(argv, stdin=None, timeout=None):
            if argv[0] == "git" and argv[5] == "fetch":
                return w.Result(128, "", "fatal: unable to access")
            return runner_call(argv, stdin, timeout)

        self.assertEqual(self.run_watch(offline), 1)
        self.assertFalse(os.path.exists(self.cfg["statePath"]))
        self.assertIn("git fetch failed (128): fatal: unable to access", self.log_lines()[-1])


if __name__ == "__main__":
    unittest.main()
