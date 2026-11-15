# limit-revive

A Claude Code mod that revives a session after the 5-hour usage limit resets.

When the 5-hour window passes a set percent (default 90%) **and there is unfinished work**, it schedules a
resume at the window's reset time + N minutes (default 5) and submits "continue where you left off" into the
same session. If the session simply finishes on its own, any armed timer is obsolete and is cancelled, so
nothing is ever "continued" for no reason.

## Modes (`mode` setting)
- `resume-only` (default): never interrupts. Resumes only a turn that died at the limit.
- `finish-turn`: lets the running turn finish, holds new prompts typed over the threshold, and sends them at reset.
- `stop-now`: aborts the running turn at the threshold to save budget, and resumes it after the reset.

## Windows fallback
With `windowsFallback` on (default), it also registers a one-shot Task Scheduler job
(`ClaudeLimitRevive_<id>`), 2 minutes after the in-session timer. The job opens Windows Terminal with
`claude --resume <session> "<prompt>"`, so the session is revived even if its window was closed. The in-session
path deletes the job before it resumes, and the job deletes itself after it expires.

## Commands
`/limit-revive status` | `cancel` | `now`

## Settings
Edit them in `/config` (plugin options) or under `pluginConfigs.limit-revive` in settings:
`thresholdPercent`, `delayMinutes`, `mode`, `resumePrompt`, `windowsFallback`.
