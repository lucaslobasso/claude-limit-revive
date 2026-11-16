import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, Timer } from 'claude-code'

import type { OsTask, Pending, PendingReason } from '../types'

const PLUGIN = 'limit-revive'
const MINUTE = 60_000
/** The OS task fires this long after the in-session timer, so the two never race. */
const OS_GRACE_MS = 2 * MINUTE
const TASK_PREFIX = 'ClaudeLimitRevive_'
const TASKS_KEY = 'tasks'
const DEFAULT_PROMPT =
  'The usage limit has reset. Continue exactly where you left off.'
const MODES = ['resume-only', 'finish-turn', 'stop-now'] as const
type Mode = (typeof MODES)[number]

const pendingAtom = atom(
  { plugin: 'limit-revive', key: 'pending' } as const,
  null as Pending | null,
  { shape: 'pending-1' },
)
const overrideAtom = atom({ plugin: 'limit-revive', key: 'overrideUntil' } as const, 0, {
  shape: 'override-1',
})

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
const fiveHourOf = (limits: readonly SessionRateLimit[]) =>
  limits.find(limit => limit.kind === 'five_hour')
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
}

// Fixed per activation: register() fills it, and a change of options reloads.
let cfg = {
  threshold: 90,
  delayMs: 5 * MINUTE,
  mode: 'resume-only' as Mode,
  resumePrompt: DEFAULT_PROMPT,
  useOsFallback: true,
}

// The fallback uses Task Scheduler, so it only runs on Windows (set at session start).
let isWindows = false
// A background session (agent view, `claude --bg`) has no window, and its
// process is retired after about an hour idle: the in-session timer dies with
// it, so only the OS task can bring it back, and it must do so in the background.
let isBackground = false

// Module variables start over on a reload; the durable parts live in $.state.
let timer: Timer | undefined
let mainTurnId: string | undefined
let fiveHour: SessionRateLimit | undefined
let cwd = ''
const exePaths = new Map<string, string | undefined>()

async function setPending($: EngineInterface, value: Pending | null) {
  await update($, pendingAtom, () => value)
}

async function refreshFiveHour($: EngineInterface) {
  try {
    fiveHour = fiveHourOf((await $.session.usage()).rateLimits) ?? fiveHour
  } catch {
    // Keep the last reading.
  }
}

/** Over the threshold in a window that has not reset yet. */
function isOver(now: number) {
  return (
    fiveHour !== undefined &&
    fiveHour.percentUsed >= cfg.threshold &&
    (fiveHour.resetsAt === undefined || Date.parse(fiveHour.resetsAt) > now)
  )
}

async function isOverridden($: EngineInterface, now: number) {
  return (await read($, overrideAtom)) > now
}

function showStatus($: EngineInterface, pending: Pending | null) {
  $.ui.status(
    pending
      ? `⏸ revive at ${clockTime(pending.resumeAt)} (${REASON_TEXT[pending.reason]})`
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
  showStatus($, pending)
}

async function arm(
  $: EngineInterface,
  reason: PendingReason,
  heldText?: string,
): Promise<Pending | null> {
  if (!fiveHour?.resetsAt) await refreshFiveHour($)
  const resetsAt = fiveHour?.resetsAt
  if (!resetsAt) {
    $.ui.toast(`${PLUGIN}: no 5-hour reset time known, nothing scheduled.`)
    return null
  }
  const previous = await read($, pendingAtom)
  if (previous?.taskName) await deleteOsTask($, previous.taskName)

  const pending: Pending = {
    reason,
    resetsAt,
    resumeAt: Date.parse(resetsAt) + cfg.delayMs,
    ...(heldText !== undefined ? { heldText } : {}),
  }
  if (cfg.useOsFallback && isWindows) {
    const taskName = await scheduleOsTask($, pending)
    if (taskName) pending.taskName = taskName
  }
  await setPending($, pending)
  await startTimer($, pending)
  $.ui.toast(
    `${PLUGIN}: ${REASON_TEXT[reason]}; resuming at ${clockTime(pending.resumeAt)}.`,
  )
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
  showStatus($, null)
  if (pending && why) $.ui.toast(`${PLUGIN}: revive cancelled (${why}).`)
  return pending
}

async function revive($: EngineInterface, force: boolean) {
  timer = undefined
  const pending = await read($, pendingAtom)
  if (!pending) return // Obsolete: the work finished or was resumed by hand.

  if (!force) {
    await refreshFiveHour($)
    const now = await $.clock.now()
    if (isOver(now) && fiveHour?.resetsAt && fiveHour.resetsAt !== pending.resetsAt) {
      // The window moved on and is still over: wait for the new reset.
      await arm($, pending.reason, pending.heldText)
      return
    }
  }

  if (pending.taskName) await deleteOsTask($, pending.taskName)
  await setPending($, null)
  await update($, overrideAtom, () => 0)
  showStatus($, null)
  await $.prompt.submit({ text: pending.heldText ?? cfg.resumePrompt })
}

async function stopAndArm($: EngineInterface, turnId: string) {
  const armed = await arm($, 'aborted-by-mod')
  if (armed) await $.turn.abort({ turnId })
}

async function hold($: EngineInterface, pending: Pending | null, text: string) {
  if (!pending) return arm($, 'held-prompt', text)
  const held: Pending = { ...pending, reason: 'held-prompt', heldText: text }
  await setPending($, held)
  return held
}

export const register: Register = (on, options) => {
  cfg = {
    threshold: num(options.thresholdPercent, 90),
    delayMs: num(options.delayMinutes, 5) * MINUTE,
    mode: MODES.includes(options.mode as Mode) ? (options.mode as Mode) : 'resume-only',
    resumePrompt: String(options.resumePrompt || DEFAULT_PROMPT),
    useOsFallback: options.windowsFallback !== false,
  }

  // ---- Hooks -----------------------------------------------------------------

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    isWindows = (await $.env.get('OS')) === 'Windows_NT'
    isBackground = Boolean(await $.env.get('CLAUDE_JOB_DIR'))
    await $.command.register({
      name: PLUGIN,
      description: 'Auto-resume after the 5-hour limit: status | cancel | now',
      argumentHint: '[status|cancel|now]',
      immediate: true,
    })
    await refreshFiveHour($)

    const now = await $.clock.now()
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
          const adopted = { ...task.pending, taskName: name }
          await setPending($, adopted)
          await startTimer($, adopted)
        }
      }
      await $.store.set(TASKS_KEY, kept)
    }
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
      // The session finished on its own: any revive is obsolete.
      await clear($, 'the session finished')
    } else if (e.reason === 'error' && !(await read($, pendingAtom))) {
      await refreshFiveHour($)
      if (fiveHour && fiveHour.percentUsed >= cfg.threshold) {
        await arm($, 'limit-error')
      }
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    fiveHour = fiveHourOf(e.rateLimits) ?? fiveHour
    const result = await next(e)

    const turnId = mainTurnId
    if (cfg.mode === 'stop-now' && turnId !== undefined) {
      const now = await $.clock.now()
      if (
        isOver(now) &&
        !(await isOverridden($, now)) &&
        !(await read($, pendingAtom))
      ) {
        // Leave the measure first: the abort ends the turn this hook sits in.
        void stopAndArm($, turnId)
      }
    }
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    const byPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (!byPerson) return next(e)

    const now = await $.clock.now()
    const pending = await read($, pendingAtom)

    if (cfg.mode === 'finish-turn' && isOver(now) && !(await isOverridden($, now))) {
      const armed = await hold($, pending, e.text)
      if (armed) {
        return {
          drop: `${PLUGIN}: held until ${clockTime(armed.resumeAt)}; /${PLUGIN} cancel to stop holding.`,
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
    const now = await $.clock.now()

    if (action === 'cancel') {
      const pending = await clear($)
      await update($, overrideAtom, () =>
        fiveHour?.resetsAt ? Date.parse(fiveHour.resetsAt) : 0,
      )
      if (!pending) return { text: 'Nothing scheduled.' }
      return {
        text:
          'Revive cancelled; the mod stays out of the way until the window resets.' +
          (pending.heldText ? `\nHeld prompt (not sent):\n${pending.heldText}` : ''),
      }
    }

    if (action === 'now') {
      if (!(await read($, pendingAtom))) return { text: 'Nothing scheduled.' }
      void revive($, true)
      return { text: 'Reviving now.' }
    }

    await refreshFiveHour($)
    const pending = await read($, pendingAtom)
    const override = await read($, overrideAtom)
    const lines = [
      `mode ${cfg.mode}, threshold ${cfg.threshold}%, delay ${cfg.delayMs / MINUTE} min, Windows fallback ${!cfg.useOsFallback ? 'off' : isWindows ? 'on' : 'off (not Windows)'}${isBackground ? ', background session' : ''}`,
      fiveHour
        ? `5-hour window: ${fiveHour.percentUsed}% used` +
          (fiveHour.resetsAt ? `, resets ${clockTime(Date.parse(fiveHour.resetsAt))}` : '')
        : '5-hour window: no reading yet',
      pending
        ? `revive at ${clockTime(pending.resumeAt)} (${REASON_TEXT[pending.reason]})` +
          (pending.taskName ? `, Windows task ${pending.taskName}` : '')
        : 'nothing scheduled',
    ]
    if (override > now) lines.push(`overridden until ${clockTime(override)}`)
    return { text: lines.join('\n') }
  }).catch(() => ({ text: `${PLUGIN}: the command failed; see claude --debug.` }))
}
