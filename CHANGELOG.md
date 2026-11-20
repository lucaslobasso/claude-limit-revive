# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## 2026-11-20: claude-limit-revive becomes claude-sessions

The repository is now the `claude-sessions` marketplace with three plugins under `plugins/`. Install ids change from
`limit-revive@claude-limit-revive` to `<plugin>@claude-sessions`.

### limit-revive [2.0.0]

#### Added
- Weekly (`seven_day`) limit. Past `weeklyThresholdPercent` (95) with the reset within `weeklyReviveWithinHours` (12),
  the session is revived after the weekly reset, the same way as after the 5-hour one. With the reset further away, it
  stops according to `weeklyMode` (`finish-turn`, `stop-now`, `notify-only`) and schedules nothing.
- The 5-hour revive checks the weekly window first, so a session is never resumed into an exhausted week.
- `limit_revive` tool (`status`, `arm`, `cancel`) so Claude can call it, a one-time note to the model when a threshold
  is crossed, and a `limit-revive` skill.
- `/limit-revive status` shows the weekly window.

#### Changed
- The plugin moved to `plugins/limit-revive`, and the marketplace is now `claude-sessions`.

### context-handoff [1.0.0]

#### Added
- First version. Past `thresholdPercent` (75) context fill it acts by `mode` (`finish-turn`, `stop-now`,
  `notify-only`). Claude writes a self-contained handoff file to `~/.claude/handoffs/`, and the `context_handoff` tool
  starts a new session on the same model with `--permission-mode auto`. That session reads the file, deletes it and
  continues. `/context-handoff status|now|cancel`, and a `context-handoff` skill.

### subagentify [1.0.0]

#### Added
- First version: a system-prompt rule and a `subagentify` skill. Planned work is split into subagents, Opus for work
  that needs judgment and Sonnet for well-specified work. Any spawn not on opus/sonnet gets one picked by a Haiku
  classifier (fallback `defaultModel`).

## [1.0.1] - 2026-11-16

### Fixed
- The Windows fallback task could not start: it named a bare `wt.exe`, which Task Scheduler does not look up on the user's PATH, so the task ended with `0x80070002` (file not found) and nothing resumed. The task now starts Windows Terminal and `claude` by their full paths, and starts `claude` directly when Windows Terminal is not installed.
- Background sessions (agent view, `claude --bg`) were never resumed. Claude Code retires an idle background session after about an hour, which ends the in-session timer, and the fallback tried to open a terminal for it. The task now continues such a session in the background with `claude --bg --resume`.
- A resume prompt ending in a backslash no longer breaks the task's command line.

## [1.0.0] - 2026-11-16

### Added
- Install from GitHub: `claude plugin marketplace add lucaslobasso/claude-limit-revive`.
- README with requirements, install, a full settings table, screenshots, troubleshooting and uninstall.
- CI (`claude plugin validate`, `claude plugin test .`), issue template, CLAUDE.md, `tsconfig.json` for editor type checking.

### Fixed
- The Windows Task Scheduler fallback no longer tries to run `powershell.exe` on macOS and Linux. `windowsFallback` is ignored there, and `/limit-revive status` says so.

## [0.1.0] - 2026-11-15

### Added
- First version: resume a session after the 5-hour limit resets (+N minutes), only when work is unfinished. Modes `resume-only`, `finish-turn`, `stop-now`; `/limit-revive status|cancel|now`; Windows Task Scheduler fallback.

[1.0.1]: https://github.com/lucaslobasso/claude-limit-revive/compare/limit-revive--v1.0.0...limit-revive--v1.0.1
[1.0.0]: https://github.com/lucaslobasso/claude-limit-revive/compare/limit-revive--v0.1.0...limit-revive--v1.0.0
[0.1.0]: https://github.com/lucaslobasso/claude-limit-revive/releases/tag/limit-revive--v0.1.0
[2.0.0]: https://github.com/lucaslobasso/claude-sessions/compare/limit-revive--v1.0.1...limit-revive--v2.0.0
