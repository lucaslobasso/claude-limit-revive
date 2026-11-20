# claude-sessions

Claude Code marketplace `claude-sessions` (this repo, formerly claude-limit-revive) with three function-hook plugins
under `plugins/`:

- `limit-revive`: resumes a session after the 5-hour limit resets, and after the weekly limit when its reset is
  within `weeklyReviveWithinHours` (otherwise it stops at the weekly threshold per `weeklyMode`). Tool `limit_revive`,
  command `/limit-revive`, Windows Task Scheduler fallback.
- `context-handoff`: past a context-fill threshold, Claude writes a handoff file to `~/.claude/handoffs/`, and a new
  session starts on the same model in auto mode. That session reads the file, then deletes it. Tool `context_handoff`,
  command `/context-handoff`.
- `subagentify`: a system-prompt rule plus a skill for splitting planned work into Opus/Sonnet subagents, and an
  `agent.spawn` hook that classifies any spawn not on opus/sonnet (Haiku classifier).

Each plugin is self-contained: `.claude-plugin/plugin.json`, `hooks/register.ts` (+ `register.test.ts`), `types/`,
`skills/<name>/SKILL.md`, `tsconfig.json`. An installed plugin can't import outside its folder, so limit-revive and
context-handoff each carry their own copy of the exe helpers (`pickExecutable`, `resolveExe`, `forCommandLine`, the
wt / `claude --bg` launch). **Keep those copies identical.**

- Rule that must hold (limit-revive): a timer is only valid while there is unfinished work. A turn that finishes
  normally, or a prompt the user types, cancels the timer and the OS task.
- Try changes: `claude --plugin-dir plugins/<name>` (not alongside a marketplace install of the same plugin: hooks
  fire twice).
- Check: `claude plugin validate .claude-plugin/marketplace.json`, then `claude plugin validate plugins/<name>` and
  `claude plugin test plugins/<name>` (CI runs these for each plugin).
- Screenshots: `python docs/screenshots.py` (real sessions offscreen via claude-boxed-messages `docs/capture.py`).
- Release a plugin: bump `version` in `plugins/<name>/.claude-plugin/plugin.json` **and** that plugin's entry in
  `.claude-plugin/marketplace.json` (plus `metadata.version` there when it's a notable release), add a CHANGELOG entry
  under that plugin, merge, then `claude plugin tag plugins/<name> --push` (tags `<name>--vX.Y.Z`).
- README layout and the "Install the whole set" block are shared with the other repos of the set (canonical copy:
  claude-launcher `docs/bundle-section.md`). Keep the block between the `bundle:start`/`bundle:end` markers identical.
