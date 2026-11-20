---
name: limit-revive
description: Use when the 5-hour or weekly usage limit is near or over its threshold (a limit-revive note says so), when work must resume after a usage-limit reset, or when asked about the weekly limit or what limit-revive has scheduled.
---

# limit-revive

The limit-revive plugin watches the 5-hour and weekly usage limits and resumes this session after a reset, so unfinished work is not lost to a limit.

## What it does on its own

- **5-hour limit**: when usage passes the threshold with work unfinished, it schedules a resume at the reset + a few minutes (an in-session timer, plus a Windows Task Scheduler job that reopens the session if its window was closed).
- **Weekly limit**: if the weekly reset is within the revive window (12 h by default), it waits for that reset the same way. If the reset is further away, it schedules nothing and stops as the weekly mode says. It never resumes into an exhausted week.
- A scheduled resume is only kept while work is unfinished: a turn that ends with a final answer, or a prompt the person types, cancels it.
- When a threshold is first crossed during a turn, it adds a note to the conversation.

## The `limit_revive` tool

- `status`: usage of both windows, the modes, and what is scheduled.
- `arm`: schedule a resume for the window that is over (or the next known reset) and get the time back. Use it when you are near or over a threshold and work will remain. A resume armed this way survives the end of the turn it was armed in.
- `cancel`: drop a scheduled resume or a weekly stop; the plugin stays out of the way until the reset.

## Modes

- `mode` (5-hour, and a weekly reset within the revive window): `resume-only` resumes only a turn that died on the limit; `finish-turn` lets the turn finish and holds new prompts until the reset; `stop-now` aborts the running turn at the threshold and resumes it later.
- `weeklyMode` (weekly reset further away): `finish-turn` lets the turn finish and drops new prompts with the reset time; `stop-now` aborts the running turn once; `notify-only` only shows a toast and adds a note.

## When a threshold is crossed

Bring the work to a clean, resumable point: finish the current step, leave files consistent, and write a short note of what is left and what comes next. Then call `limit_revive` with `arm` if work remains, and end the turn. The resume prompt tells you to continue where you left off.
