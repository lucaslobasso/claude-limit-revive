import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, Timer } from 'claude-code'

import type { LimitWindow, OsTask, Pending, PendingReason } from '../types'

const PLUGIN = 'limit-revive'
const MINUTE = 60_000
const HOUR = 60 * MINUTE
/** The OS task fires this long after the in-session timer, so the two never race. */
const OS_GRACE_MS = 2 * MINUTE
const TASK_PREFIX = 'ClaudeLimitRevive_'
const TASKS_KEY = 'tasks'
const DEFAULT_PROMPT =
  'The usage limit has reset. Continue exactly where you left off.'
const MODES = ['resume-only', 'finish-turn', 'stop-now'] as const
type Mode = (typeof MODES)[number]
const WEEKLY_MODES = ['finish-turn', 'stop-now', 'notify-only'] as const
type WeeklyMode = (typeof WEEKLY_MODES)[number]
/** The model-facing tool: registered as `limit_revive`, called by its full MCP name. */
const TOOL = 'limit_revive'
const TOOL_FULL = 'mcp__limit-revive__limit_revive'
const TOOL_ACTIONS = ['status', 'arm', 'cancel'] as const
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const pendingAtom = atom(
  { plugin: 'limit-revive', key: 'pending' } as const,
  null as Pending | null,
  { shape: 'pending-2' },
)
const overrideAtom = atom({ plugin: 'limit-revive', key: 'overrideUntil' } as const, 0, {
  shape: 'override-1',
})
/** The weekly reset (ms) the session is stopped until, with nothing scheduled; 0 = none. */
const weeklyStopAtom = atom({ plugin: 'limit-revive', key: 'weeklyStop' } as const, 0, {
  shape: 'weekly-stop-1',
})
/** Per window, the reset whose threshold crossing the model was already told about. */
const notedAtom = atom(
  { plugin: 'limit-revive', key: 'noted' } as const,
  {} as Partial<Record<LimitWindow, string>>,
  { shape: 'noted-1' },
)

// Registers the scheduled task. Values arrive through env vars, never through
// string-built PowerShell, so paths and prompts need no escaping here.
// LR_EXE is always a full path: Task Scheduler does not look a bare name up on
// the user's PATH, where wt.exe and claude.exe are, and the task then ends
// with 0x80070002 (file not found) without resuming anything.
const PS_CREATE = [
  "$ErrorActionPreference = 'Stop'",
  '$at = [datetime]::Parse($env:LR_AT)',
  '$action = New-ScheduledTaskAction -Execute $env:LR_EXE -Argument $env:LR_ARGS -WorkingDirectory $env:LR_CWD',
  '$trigger = New-ScheduledTaskTrigger -Once -At $at',
  "$trigger.EndBoundary = $at.AddHours(6).ToString('s')",
  '$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DeleteExpiredTaskAfter (New-TimeSpan -Minutes 1)',
  'Register-ScheduledTask -TaskName $env:LR_NAME -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null',
].join('; ')
const PS_DELETE =
  'Unregister-ScheduledTask -TaskName $env:LR_NAME -Confirm:$false -ErrorAction SilentlyContinue'

const num = (value: unknown, fallback: number) => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}
const pad = (n: number) => String(n).padStart(2, '0')
const clockTime = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
/** A weekly reset can be days away: the weekday says which one. */
const dayTime = (ms: number) => `${DAYS[new Date(ms).getDay()]} ${clockTime(ms)}`
const windowOf = (limits: readonly SessionRateLimit[], kind: LimitWindow) =>
  limits.find(limit => limit.kind === kind)
/**
 * Safe inside a quoted argument of a wt.exe line: no quotes, no `;` (wt's
 * separator), no backslash left at the end to swallow the closing quote.
 */
const forCommandLine = (text: string) =>
  text.replace(/["`;]/g, '').replace(/\s+/g, ' ').trim().slice(0, 500).replace(/\\+$/, '')
/** Of `where.exe`'s matches, one Task Scheduler can start: an .exe, else a .cmd or .bat. */
const pickExecutable = (stdout: string) => {
  const found = stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  return (
    found.find(path => /\.exe$/i.test(path)) ?? found.find(path => /\.(cmd|bat)$/i.test(path))
  )
}

const REASON_TEXT: Record<PendingReason, string> = {
  'limit-error': 'turn stopped at the limit',
  'aborted-by-mod': 'stopped at the threshold',
  'held-prompt': 'prompt held',
  requested: 'requested by Claude',
}
const WINDOW_TEXT: Record<LimitWindow, string> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
}

// Fixed per activation: register() fills it, and a change of options reloads.
let cfg = {
  threshold: 90,
  delayMs: 5 * MINUTE,
  mode: 'resume-only' as Mode,
  resumePrompt: DEFAULT_PROMPT,
  useOsFallback: true,
  weeklyEnabled: true,
  weeklyThreshold: 95,
  weeklyWithinMs: 12 * HOUR,
  weeklyMode: 'finish-turn' as WeeklyMode,
}

// The fallback uses Task Scheduler, so it only runs on Windows (set at session start).
let isWindows = false
// A background session (agent view, `claude --bg`) has no window, and its
// process is retired after about an hour idle: the in-session timer dies with
// it, so only the OS task can bring it back, and it must do so in the background.
let isBackground = false

// Module variables start over on a reload; the durable parts live in $.state.
let timer: Timer | undefined
let stopTimer: Timer | undefined
let mainTurnId: string | undefined
let fiveHour: SessionRateLimit | undefined
let sevenDay: SessionRateLimit | undefined
let cwd = ''
const exePaths = new Map<string, string | undefined>()

async function setPending($: EngineInterface, value: Pending | null) {
  await update($, pendingAtom, () => value)
}

function takeReadings(limits: readonly SessionRateLimit[]) {
  fiveHour = windowOf(limits, 'five_hour') ?? fiveHour
  sevenDay = windowOf(limits, 'seven_day') ?? sevenDay
}

async function refreshLimits($: EngineInterface) {
  try {
    takeReadings((await $.session.usage()).rateLimits)
  } catch {
    // Keep the last readings.
  }
}

const readingOf = (kind: LimitWindow) => (kind === 'five_hour' ? fiveHour : sevenDay)
const thresholdOf = (kind: LimitWindow) =>
  kind === 'five_hour' ? cfg.threshold : cfg.weeklyThreshold

/**
 * The window's reading when it is over its threshold and has not reset yet.
 * The weekly one also needs a known reset: without it there is nothing to
 * wait for and nothing to tell the person.
 */
function overWindow(kind: LimitWindow, now: number) {
  const limit = readingOf(kind)
  if (!limit || limit.percentUsed < thresholdOf(kind)) return undefined
  if (kind === 'seven_day' && (!cfg.weeklyEnabled || !limit.resetsAt)) return undefined
  if (limit.resetsAt !== undefined && Date.parse(limit.resetsAt) <= now) return undefined
  return limit
}

type Target = { window: LimitWindow; resetsAt: string }

/**
 * The window a revive must wait for now. The weekly one wins when it is over
 * and resets after the 5-hour one: resuming at the 5-hour reset would only
 * run into an exhausted week. Undefined when no window is over.
 */
function blocking(now: number): (Target & { limit: SessionRateLimit }) | undefined {
  const week = overWindow('seven_day', now)
  const five = overWindow('five_hour', now)
  const weekLater =
    week?.resetsAt !== undefined &&
    (!five?.resetsAt || Date.parse(week.resetsAt) > Date.parse(five.resetsAt))
  if (week?.resetsAt && (weekLater || !five)) {
    return { window: 'seven_day', resetsAt: week.resetsAt, limit: week }
  }
  if (five?.resetsAt) return { window: 'five_hour', resetsAt: five.resetsAt, limit: five }
  return undefined
}

/** What arm() waits for: the blocking window, else the 5-hour reset if one is known. */
function targetOf(now: number): Target | undefined {
  const block = blocking(now)
  if (block) return block
  return fiveHour?.resetsAt ? { window: 'five_hour', resetsAt: fiveHour.resetsAt } : undefined
}

/** A weekly reset too far away to wait for in a session (beyond weeklyReviveWithinHours). */
const isFar = (target: Target, now: number) =>
  target.window === 'seven_day' && Date.parse(target.resetsAt) - now > cfg.weeklyWithinMs

/** The weekly reset when the week is over and too far off to revive on, else undefined. */
function weeklyFarReset(now: number) {
  const block = blocking(now)
  return block && isFar(block, now) ? block.resetsAt : undefined
}

async function isOverridden($: EngineInterface, now: number) {
  return (await read($, overrideAtom)) > now
}

const resumeText = (pending: Pending) =>
  pending.window === 'seven_day' ? dayTime(pending.resumeAt) : clockTime(pending.resumeAt)

/** A pending revive shows first; else a weekly stop still in force. */
async function refreshStatus($: EngineInterface) {
  const pending = await read($, pendingAtom)
  const stoppedUntil = await read($, weeklyStopAtom)
  const now = await $.clock.now()
  $.ui.status(
    pending
      ? `⏸ revive at ${resumeText(pending)} (${REASON_TEXT[pending.reason]})`
      : stoppedUntil > now
        ? `⏹ weekly limit, resets ${dayTime(stoppedUntil)}`
        : undefined,
  )
}

// ---- Windows Task Scheduler fallback -----------------------------------

async function readTasks($: EngineInterface) {
  return ((await $.store.get(TASKS_KEY)) ?? {}) as Record<string, OsTask>
}

/** The full path of a command on the user's PATH, or undefined when it has none. */
async function resolveExe($: EngineInterface, command: string) {
  if (exePaths.has(command)) return exePaths.get(command)
  let path: string | undefined
  try {
    const { exitCode, stdout } = await $.process.run(['where.exe', command])
    if (exitCode === 0) path = pickExecutable(stdout)
  } catch {
    // Not found.
  }
  exePaths.set(command, path)
  return path
}

/** What the scheduled task starts, every executable by its full path. */
async function fallbackAction($: EngineInterface, sessionId: string, prompt: string) {
  const claude = await resolveExe($, 'claude')
  if (!claude) return undefined
  if (isBackground) {
    // Continues the background session under its own id, with no window.
    return { exe: claude, args: `--bg --resume ${sessionId} "${prompt}"` }
  }
  const wt = await resolveExe($, 'wt')
  return wt
    ? { exe: wt, args: `-d "${cwd}" "${claude}" --resume ${sessionId} "${prompt}"` }
    : { exe: claude, args: `--resume ${sessionId} "${prompt}"` }
}

async function scheduleOsTask($: EngineInterface, pending: Pending) {
  try {
    const sessionId = await $.session.id()
    const name = TASK_PREFIX + sessionId.slice(0, 8)
    const at = pending.resumeAt + OS_GRACE_MS
    const prompt = forCommandLine(pending.heldText ?? cfg.resumePrompt)
    const action = await fallbackAction($, sessionId, prompt)
    if (!action) {
      $.ui.toast(`${PLUGIN}: Windows task not scheduled: claude was not found on PATH.`)
      return undefined
    }
    const run = await $.process.run(
      ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', PS_CREATE],
      {
        env: {
          LR_AT: new Date(at).toISOString(),
          LR_EXE: action.exe,
          LR_ARGS: action.args,
          LR_CWD: cwd,
          LR_NAME: name,
        },
        timeoutMs: 30_000,
      },
    )
    if (run.exitCode !== 0) {
      $.ui.toast(`${PLUGIN}: Windows task not scheduled: ${run.stderr.trim().split(/\r?\n/)[0] ?? ''}`)
      return undefined
    }
    const tasks = await readTasks($)
    await $.store.set(TASKS_KEY, { ...tasks, [name]: { sessionId, at, pending } })
    return name
  } catch (error) {
    $.ui.toast(`${PLUGIN}: Windows task not scheduled: ${String(error)}`)
    return undefined
  }
}

async function deleteOsTask($: EngineInterface, name: string) {
  try {
    await $.process.run(
      ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', PS_DELETE],
      { env: { LR_NAME: name }, timeoutMs: 30_000 },
    )
  } catch {
    // Already gone, or PowerShell unavailable; it also expires by itself.
  }
  const { [name]: _gone, ...rest } = await readTasks($)
  await $.store.set(TASKS_KEY, rest)
}

// ---- Arming, clearing, reviving -----------------------------------------

async function startTimer($: EngineInterface, pending: Pending) {
  timer?.cancel()
  const wait = Math.max(0, pending.resumeAt - (await $.clock.now()))
  timer = $.clock.after(wait, () => void revive($, false))
  await refreshStatus($)
}

/** Clears the weekly stop once its reset passes, so the status line goes with it. */
async function startStopTimer($: EngineInterface, until: number) {
  stopTimer?.cancel()
  const wait = Math.max(0, until - (await $.clock.now()))
  stopTimer = $.clock.after(wait, () => void endWeeklyStop($))
}

async function endWeeklyStop($: EngineInterface) {
  stopTimer = undefined
  await update($, weeklyStopAtom, () => 0)
  await refreshStatus($)
}

/**
 * The week is out and its reset too far to wait for: nothing is scheduled
 * (a revive would resume into the exhausted week), the status line says so.
 * True when this stop is new, not one already in force for the same reset.
 */
async function stopForWeek($: EngineInterface, resetsAt: string) {
  const until = Date.parse(resetsAt)
  const dropped = await clear($)
  const fresh = (await read($, weeklyStopAtom)) !== until
  await update($, weeklyStopAtom, () => until)
  await startStopTimer($, until)
  await refreshStatus($)
  if (fresh) {
    $.ui.toast(
      `${PLUGIN}: weekly limit over ${cfg.weeklyThreshold}%; nothing scheduled, it resets ${dayTime(until)}.`,
    )
  }
  if (dropped?.heldText) {
    $.ui.toast(`${PLUGIN}: held prompt not sent (weekly limit): ${dropped.heldText}`)
  }
  return fresh
}

type ArmExtra = { heldText?: string; turnId?: string }

async function arm(
  $: EngineInterface,
  reason: PendingReason,
  extra: ArmExtra = {},
): Promise<Pending | null> {
  if (!fiveHour?.resetsAt || !sevenDay) await refreshLimits($)
  const now = await $.clock.now()
  const target = targetOf(now)
  if (!target) {
    $.ui.toast(`${PLUGIN}: no reset time known, nothing scheduled.`)
    return null
  }
  if (isFar(target, now)) {
    await stopForWeek($, target.resetsAt)
    return null
  }
  const previous = await read($, pendingAtom)
  if (previous?.taskName) await deleteOsTask($, previous.taskName)

  const pending: Pending = {
    reason,
    window: target.window,
    resetsAt: target.resetsAt,
    resumeAt: Date.parse(target.resetsAt) + cfg.delayMs,
    ...(extra.heldText !== undefined ? { heldText: extra.heldText } : {}),
    ...(extra.turnId !== undefined ? { turnId: extra.turnId } : {}),
  }
  if (cfg.useOsFallback && isWindows) {
    const taskName = await scheduleOsTask($, pending)
    if (taskName) pending.taskName = taskName
  }
  await setPending($, pending)
  await startTimer($, pending)
  $.ui.toast(`${PLUGIN}: ${REASON_TEXT[reason]}; resuming at ${resumeText(pending)}.`)
  if (isBackground && !pending.taskName) {
    $.ui.toast(
      `${PLUGIN}: a background session is retired when idle; without the Windows task it may not resume.`,
    )
  }
  return pending
}

/** Drops the timer and the OS task: the work they were for is gone. */
async function clear($: EngineInterface, why?: string) {
  timer?.cancel()
  timer = undefined
  const pending = await read($, pendingAtom)
  if (pending?.taskName) await deleteOsTask($, pending.taskName)
  await setPending($, null)
  await refreshStatus($)
  if (pending && why) $.ui.toast(`${PLUGIN}: revive cancelled (${why}).`)
  return pending
}

async function revive($: EngineInterface, force: boolean) {
  timer = undefined
  const pending = await read($, pendingAtom)
  if (!pending) return // Obsolete: the work finished or was resumed by hand.

  if (!force) {
    await refreshLimits($)
    const block = blocking(await $.clock.now())
    if (block && block.resetsAt !== pending.resetsAt) {
      // A window is still over with a later reset (the 5-hour one moved on,
      // or the week ran out meanwhile): wait for it, or stop for the week.
      await arm($, pending.reason, pending.heldText !== undefined ? { heldText: pending.heldText } : {})
      return
    }
  }

  if (pending.taskName) await deleteOsTask($, pending.taskName)
  await setPending($, null)
  await update($, overrideAtom, () => 0)
  await refreshStatus($)
  await $.prompt.submit({ text: pending.heldText ?? cfg.resumePrompt })
}

async function stopAndArm($: EngineInterface, turnId: string) {
  const armed = await arm($, 'aborted-by-mod')
  if (armed) await $.turn.abort({ turnId })
}

async function hold($: EngineInterface, pending: Pending | null, text: string) {
  if (!pending) return arm($, 'held-prompt', { heldText: text })
  const held: Pending = { ...pending, reason: 'held-prompt', heldText: text }
  await setPending($, held)
  return held
}

// ---- The model's side: a note at the threshold, a tool to act on it -----

function crossingNote(kind: LimitWindow, limit: SessionRateLimit, now: number) {
  const reset = limit.resetsAt ? Date.parse(limit.resetsAt) : undefined
  const when = reset === undefined ? '' : `; it resets ${kind === 'seven_day' ? dayTime(reset) : clockTime(reset)}`
  const far = kind === 'seven_day' && reset !== undefined && reset - now > cfg.weeklyWithinMs
  return (
    `${PLUGIN}: the ${WINDOW_TEXT[kind]} usage limit passed ${thresholdOf(kind)}% ` +
    `(${limit.percentUsed}% used${when}). Bring the work to a clean, resumable point soon: ` +
    'finish the current step and leave a short note of what is left. ' +
    (far
      ? 'The weekly reset is too far off to resume automatically; the person resumes after it.'
      : `If work will remain, call the ${TOOL} tool with action "arm" so the session resumes ` +
        'after the reset; "status" shows what is scheduled.')
  )
}

/** Tells the model, once per window reset, that a threshold was crossed during its turn. */
async function noteCrossings($: EngineInterface, now: number) {
  const noted = await read($, notedAtom)
  for (const kind of ['five_hour', 'seven_day'] as const) {
    const limit = overWindow(kind, now)
    const key = limit?.resetsAt ?? 'unknown'
    if (!limit || noted[kind] === key) continue
    await update($, notedAtom, value => ({ ...value, [kind]: key }))
    if (kind === 'seven_day' && cfg.weeklyMode === 'notify-only' && weeklyFarReset(now)) {
      $.ui.toast(`${PLUGIN}: weekly limit over ${cfg.weeklyThreshold}% (${limit.percentUsed}% used).`)
    }
    try {
      await $.session.append({
        message: { type: 'user', content: [{ type: 'text', text: crossingNote(kind, limit, now) }] },
      })
    } catch {
      // A refused note leaves the model uninformed, never the limit unhandled.
    }
  }
}

async function statusText($: EngineInterface) {
  await refreshLimits($)
  const now = await $.clock.now()
  const pending = await read($, pendingAtom)
  const override = await read($, overrideAtom)
  const stoppedUntil = await read($, weeklyStopAtom)
  const lines = [
    `mode ${cfg.mode}, threshold ${cfg.threshold}%, delay ${cfg.delayMs / MINUTE} min, Windows fallback ${!cfg.useOsFallback ? 'off' : isWindows ? 'on' : 'off (not Windows)'}${isBackground ? ', background session' : ''}`,
    fiveHour
      ? `5-hour window: ${fiveHour.percentUsed}% used` +
        (fiveHour.resetsAt ? `, resets ${clockTime(Date.parse(fiveHour.resetsAt))}` : '')
      : '5-hour window: no reading yet',
    !cfg.weeklyEnabled
      ? 'weekly: off'
      : sevenDay
        ? `weekly: ${sevenDay.percentUsed}% used` +
          (sevenDay.resetsAt ? `, resets ${dayTime(Date.parse(sevenDay.resetsAt))}` : '') +
          ` (threshold ${cfg.weeklyThreshold}%, ${cfg.weeklyMode})` +
          (stoppedUntil > now ? `, stopped until ${dayTime(stoppedUntil)}` : '')
        : 'weekly: no reading yet',
    pending
      ? `revive at ${resumeText(pending)} (${REASON_TEXT[pending.reason]}, ${WINDOW_TEXT[pending.window]} reset)` +
        (pending.taskName ? `, Windows task ${pending.taskName}` : '')
      : 'nothing scheduled',
  ]
  if (override > now) lines.push(`overridden until ${dayTime(override)}`)
  return lines.join('\n')
}

/** The person (or the model for them) says stop: no revive, no stop, until the reset. */
async function cancelByUser($: EngineInterface) {
  const now = await $.clock.now()
  const pending = await clear($)
  const stoppedUntil = await read($, weeklyStopAtom)
  // The override lasts to the reset the mod was waiting for: the weekly one
  // in a weekly stop or a weekly revive, else the 5-hour one.
  const until =
    stoppedUntil > now
      ? stoppedUntil
      : Date.parse(pending?.resetsAt ?? blocking(now)?.resetsAt ?? fiveHour?.resetsAt ?? '') || 0
  await update($, overrideAtom, () => until)
  if (stoppedUntil > now) await endWeeklyStop($)
  if (!pending && !(stoppedUntil > now)) return 'Nothing scheduled.'
  return (
    (pending ? 'Revive cancelled' : 'Weekly stop lifted') +
    '; the mod stays out of the way until the window resets.' +
    (pending?.heldText ? `\nHeld prompt (not sent):\n${pending.heldText}` : '')
  )
}

/** The model asks for a revive: on the window that is over, else the next known reset. */
async function armByRequest($: EngineInterface) {
  await refreshLimits($)
  const now = await $.clock.now()
  const target = targetOf(now)
  if (!target) return 'No reset time is known yet; nothing scheduled.'
  if (isFar(target, now)) {
    await stopForWeek($, target.resetsAt)
    return (
      `The weekly limit is over ${cfg.weeklyThreshold}% and resets ${dayTime(Date.parse(target.resetsAt))}, ` +
      'too far off to resume automatically: nothing scheduled. Stop at a clean point and say what is left.'
    )
  }
  const previous = await read($, pendingAtom)
  const armed = await arm($, 'requested', {
    ...(previous?.heldText !== undefined ? { heldText: previous.heldText } : {}),
    ...(mainTurnId !== undefined ? { turnId: mainTurnId } : {}),
  })
  if (!armed) return 'Nothing scheduled: no reset time is known.'
  return (
    `Armed: the session resumes at ${resumeText(armed)} (${WINDOW_TEXT[armed.window]} reset + ` +
    `${cfg.delayMs / MINUTE} min). Leave the work at a clean, resumable point and end the turn; ` +
    'a prompt the person types, or a later turn that finishes the work, cancels it.'
  )
}

/** The model's tool. A refusal costs the tool alone, never the revive itself. */
async function registerTool($: EngineInterface) {
  try {
    await $.tool.register({
      name: TOOL,
      description:
        'Resume this session automatically after a usage-limit reset. Use it when the 5-hour or ' +
        'weekly usage limit is near or over its threshold (a limit-revive note says so) and work ' +
        'will remain unfinished: "arm" schedules the session to resume after the reset and says ' +
        'when; "status" shows usage and what is scheduled; "cancel" drops a scheduled resume. ' +
        'After arming, bring the work to a clean, resumable point and end the turn.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: [...TOOL_ACTIONS], description: 'status | arm | cancel' },
        },
        required: ['action'],
      },
      isDeferred: false,
    })
  } catch {
    // No model tool this session; the hooks still do the work.
  }
}

export const register: Register = (on, options) => {
  cfg = {
    threshold: num(options.thresholdPercent, 90),
    delayMs: num(options.delayMinutes, 5) * MINUTE,
    mode: MODES.includes(options.mode as Mode) ? (options.mode as Mode) : 'resume-only',
    resumePrompt: String(options.resumePrompt || DEFAULT_PROMPT),
    useOsFallback: options.windowsFallback !== false,
    weeklyEnabled: options.weeklyEnabled !== false,
    weeklyThreshold: num(options.weeklyThresholdPercent, 95),
    weeklyWithinMs: num(options.weeklyReviveWithinHours, 12) * HOUR,
    weeklyMode: WEEKLY_MODES.includes(options.weeklyMode as WeeklyMode)
      ? (options.weeklyMode as WeeklyMode)
      : 'finish-turn',
  }

  // ---- Hooks -----------------------------------------------------------------

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    isWindows = (await $.env.get('OS')) === 'Windows_NT'
    isBackground = Boolean(await $.env.get('CLAUDE_JOB_DIR'))
    await $.command.register({
      name: PLUGIN,
      description: 'Auto-resume after the 5-hour or weekly limit: status | cancel | now',
      argumentHint: '[status|cancel|now]',
      immediate: true,
    })
    await registerTool($)
    await refreshLimits($)

    const now = await $.clock.now()
    const stoppedUntil = await read($, weeklyStopAtom)
    if (stoppedUntil > now) await startStopTimer($, stoppedUntil)
    else if (stoppedUntil) await update($, weeklyStopAtom, () => 0)

    const pending = await read($, pendingAtom)
    if (pending) {
      // A hot reload: the module's timer was dropped, the state was not.
      await startTimer($, pending)
    } else {
      // A fresh or resumed session: adopt this session's own future task,
      // forget the ones that already fired or expired.
      const sessionId = await $.session.id()
      const tasks = await readTasks($)
      const kept: Record<string, OsTask> = {}
      for (const [name, task] of Object.entries(tasks)) {
        if (task.at <= now) continue
        kept[name] = task
        if (task.sessionId === sessionId) {
          // A task from 1.x has no window: those were all 5-hour revives.
          const window: LimitWindow = task.pending.window ?? 'five_hour'
          const adopted: Pending = { ...task.pending, window, taskName: name }
          await setPending($, adopted)
          await startTimer($, adopted)
        }
      }
      await $.store.set(TASKS_KEY, kept)
    }
    await refreshStatus($)
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) mainTurnId = e.turnId
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    mainTurnId = undefined

    if (e.reason === 'answer') {
      const pending = await read($, pendingAtom)
      // The model armed a revive in this very turn and then wrapped up: the
      // work it declared unfinished is what the revive is for. Any other
      // finished turn makes a revive obsolete.
      const armedForThisTurn = pending?.reason === 'requested' && pending.turnId === e.turnId
      if (!armedForThisTurn) await clear($, 'the session finished')
    } else if (e.reason === 'error' && !(await read($, pendingAtom))) {
      await refreshLimits($)
      const now = await $.clock.now()
      const fiveOver = fiveHour !== undefined && fiveHour.percentUsed >= cfg.threshold
      // arm() picks the window: the weekly reset when the week is out, and a
      // weekly reset too far off schedules nothing and shows the weekly stop.
      if (fiveOver || overWindow('seven_day', now)) await arm($, 'limit-error')
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    takeReadings(e.rateLimits)
    const result = await next(e)

    const turnId = mainTurnId
    if (turnId === undefined) return result
    const now = await $.clock.now()
    await noteCrossings($, now)
    if (await isOverridden($, now)) return result

    const weekly = weeklyFarReset(now)
    if (weekly) {
      // The week is out for longer than a revive would wait: weeklyMode
      // decides, and nothing is ever scheduled.
      if (cfg.weeklyMode === 'notify-only') return result
      const fresh = await stopForWeek($, weekly)
      // Leave the measure first: the abort ends the turn this hook sits in.
      if (fresh && cfg.weeklyMode === 'stop-now') void $.turn.abort({ turnId })
      return result
    }

    if (cfg.mode === 'stop-now' && blocking(now) && !(await read($, pendingAtom))) {
      // Leave the measure first: the abort ends the turn this hook sits in.
      void stopAndArm($, turnId)
    }
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    const byPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (!byPerson) return next(e)

    const now = await $.clock.now()
    const pending = await read($, pendingAtom)
    const overridden = await isOverridden($, now)

    const weekly = overridden ? undefined : weeklyFarReset(now)
    if (weekly && cfg.weeklyMode !== 'notify-only') {
      await stopForWeek($, weekly)
      return {
        drop: `${PLUGIN}: the weekly limit is over ${cfg.weeklyThreshold}%; it resets ${dayTime(Date.parse(weekly))}. /${PLUGIN} cancel to go on anyway.`,
      }
    }

    if (cfg.mode === 'finish-turn' && blocking(now) && !overridden) {
      const armed = await hold($, pending, e.text)
      if (armed) {
        return {
          drop: `${PLUGIN}: held until ${resumeText(armed)}; /${PLUGIN} cancel to stop holding.`,
        }
      }
      return next(e)
    }

    if (pending) {
      // The person resumed by hand: the timer is obsolete, and the mod stays
      // out of the way until the window resets.
      await clear($, 'you resumed manually')
      await update($, overrideAtom, () => Date.parse(pending.resetsAt) || 0)
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // Never swallow a prompt because of this mod.

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await clear($)
    return next(e)
  })

  on('command.run', { command: PLUGIN }, async ($, e) => {
    const action = e.args.trim().toLowerCase() || 'status'

    if (action === 'cancel') return { text: await cancelByUser($) }

    if (action === 'now') {
      if (!(await read($, pendingAtom))) return { text: 'Nothing scheduled.' }
      void revive($, true)
      return { text: 'Reviving now.' }
    }

    return { text: await statusText($) }
  }).catch(() => ({ text: `${PLUGIN}: the command failed; see claude --debug.` }))

  on('tool.call', { tool: TOOL_FULL }, async ($, e) => {
    const action = String(e.action ?? 'status').toLowerCase()
    if (action === 'cancel') return { result: await cancelByUser($) }
    if (action === 'arm') return { result: await armByRequest($) }
    return { result: await statusText($) }
  }).catch(() => ({ result: `${PLUGIN}: the tool failed; see claude --debug.` }))
}
