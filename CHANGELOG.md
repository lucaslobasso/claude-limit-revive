# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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

[1.0.0]: https://github.com/lucaslobasso/claude-limit-revive/compare/limit-revive--v0.1.0...limit-revive--v1.0.0
[0.1.0]: https://github.com/lucaslobasso/claude-limit-revive/releases/tag/limit-revive--v0.1.0
