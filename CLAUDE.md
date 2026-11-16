# claude-limit-revive

Claude Code plugin (function-hook API) that resumes a session after the 5-hour usage limit resets. Plugin name
`limit-revive`, marketplace `claude-limit-revive` (this repo), installed id `limit-revive@claude-limit-revive`.

- Code: `hooks/register.ts` (hooks, `/limit-revive` command, Windows Task Scheduler fallback), shared types in `types/`.
- Rule that must hold: a timer is only valid while there is unfinished work. A turn that finishes normally, or a prompt
  the user types, cancels the timer and the OS task.
- Try changes: `claude --plugin-dir .` (not alongside a marketplace install of the same plugin: hooks fire twice).
- Check: `claude plugin test .` and `claude plugin validate .` (CI runs both).
- Screenshots: `python docs/screenshots.py` (real sessions offscreen via claude-boxed-messages `docs/capture.py`).
- Release: bump `version` in `.claude-plugin/plugin.json` **and** both versions in `marketplace.json`, add a CHANGELOG
  entry, merge, then `claude plugin tag . --push` (tags `limit-revive--vX.Y.Z`).
- README layout and the "Install the whole set" block are shared with the other repos of the set (canonical copy:
  claude-launcher `docs/bundle-section.md`); keep the block between the `bundle:start`/`bundle:end` markers identical.
