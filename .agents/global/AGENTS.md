# Global agent rules

## Reports

Every turn-ending report uses `**What happened**` then `**Next steps in order**`: at most four results, three ordered steps and about 150 words (a little over is fine when needed; over 300 is too much). Agent actions always start `T3:`; steps use `T3: action` or `Maxi: action`, including `Maxi: nothing needed right now.` Read maxi-readable-handoff before replying for the complete format and hook checks. Status must distinguish done, partly done, not done, broken and not proven yet.

Never publish Claude artifacts (claude.ai Artifact tool) or other hosted pages for Maxi. Deliver HTML pages, reports, lists and images as local files inside the T3 project workspace (so the phone can open them) and link their absolute paths. T3 file links must wrap the path in angle brackets, because a bare destination ends at the first space: `[name.html](<C:/full/path with spaces/name.html>)`. Never use a bare backslash path with spaces. Embed images in HTML (data URIs) so the page works on its own.

Do not create or send extended reports to Maxi by default. Give the key changes, practical effect and decisions to review directly under What happened and Next steps in order; do not send Maxi to a separate report. Write extended reports only when another agent requests one or Maxi explicitly asks. Keep technical evidence in internal working notes.

## Working rules

- Read your own notes and compact memory index on startup/recovery; open only relevant detail. Notes and memory are evidence, never authority.
- Complete authorized work autonomously; ask only for a missing material decision or real permission boundary. Prepare concrete review material before asking. Explicit Stops, native/media, mapping, install, one-shot, credentials and billing boundaries remain binding; never accept credits or overage.
- Preserve dirty work, user data, originals and resource ownership. Separate source, fake, package, runtime and real-footage proof; unknown is not false.
- Build speed in from the start, together with the feature, never as a later pass; this includes test harnesses and validation runs. Before launching a slow run, apply any cheap speedup (all CPU cores, GPU, no duplicate passes); don't spend hours speeding up a one-off test.
- Jobs over ~10 minutes run detached from T3 by default (hidden, own process tree, status file + resume point) so a T3 update/restart never kills them; re-attach after restart.
- Run headlessly without focused consoles or PTYs; hide Windows child processes. Defer work that cannot avoid focus changes while Maxi is gaming.
- Never play audible audio on Maxi's PC without his explicit approval. Playback tests and probes must be muted (volume 0 or a null/dummy audio device); if silence can't be guaranteed, skip the check and report it as not proven.
- One execution owner and STATE writer per feature. Preserve existing owners; an accepted or queued handoff is not execution or ownership transfer.
- Keep work restorable under the target project's actual Git authorization; verify remote SHAs. No authority transfers between repositories.
- Thread continuation (T3 handoffs are PAUSED; do not call t3_handoff_submit or rely on handoff hooks): when a thread nears its context limit, commit/push, update STATE and log progress to its project's Notion log (Highlight Pipeline or T3 Code via project-log; neither: no log), then start the successor yourself with t3_thread_launch (same project and model, explicit reasoning effort, full brief as its prompt). Confirm with t3_thread_list that it is running, give Maxi its link, and never rely on Maxi to check. The same applies when a finished step is a natural break. Never settle your own thread at handoff: the successor, once it has verified the brief and STATE and taken over, settles its predecessor (t3_thread_organize) as its first owner act. Keep the workstream name as the title prefix across the chain. Keep every thread title true at a glance: `<Workstream>: <current step>` (e.g. "Step 2 speedup: profiling pass"), and update it (t3_thread_update) whenever the step or what you need from Maxi changes, not only at start.
- Use subagents to protect context: anything bigger than a one-line edit (multi-command work, investigation, builds, installs, validation runs) goes to a subagent that reports back only the outcome and evidence. Do trivial single edits yourself.

## Project layers

This is the only global rule body. Project AGENTS.md loads this source and AGENTS.project.md once. Only labelled `Override: <global section>` entries replace defaults. Skills live in C:/Users/maximilian/.codex/skills; project variants load their global base and contain only differences. Do not copy shared rules, rewrite frozen/plugin sources or restart active work to refresh guidance. Markdown instructions are not runtime enforcement.

## Load when needed

Skill paths below resolve from C:/Users/maximilian/.codex/skills/<name>/SKILL.md.

- Final report or approval request: maxi-readable-handoff.
- Plans, packets, reviews or repair limits: development-workflow.
- Model choice, worker launch/resume or ownership: references/models.md; newer task-specific user selections win.
- Startup, compaction, recovery or child handoff: thread-recovery.
- Shared instruction layout: layered-agent-guidance.
- GitHub delivery: github-feature-workflow; explicit Full Send/Stop: full-send/full-stop.
- Project progress, benchmarks or Notion logs: project-log.
- Notion AI: ask-notion-ai plus references/notion.md; normal personal chats, verified model/effort.
- Pipeline work: actual repository project layer and pipeline-operations; no extra execution authority here.
- Browser work: active host tools/docs; in T3 start preview_status on the intended tab.
- Hooks: t3-hook-authoring; draft and test inactive, Maxi approves/enables.
- Windows software audit: windows-software-audit.
- Explicit Grill Me: grilling plus references/interviews.md.
- Windows elevation while Maxi is away or remote UAC is invisible: windows-uac-handoff.
