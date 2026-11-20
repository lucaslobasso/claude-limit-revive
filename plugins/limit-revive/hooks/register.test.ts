import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionRateLimit } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const MIN = 60_000
const T0 = Date.parse('2026-11-15T12:00:00Z')
const RESET = '2026-11-15T14:00:00Z'
const RESUME_AT = Date.parse(RESET) + 5 * MIN

type World = {
  five: SessionRateLimit | undefined
  submits: string[]
  aborts: string[]
  created: string[]
  deleted: string[]
  /** What each registered task starts: executable, arguments, working directory. */
  actions: { exe: string; args: string; cwd: string }[]
}

/** The machine beneath: its OS, whether the session is a background job, what `where.exe` finds. */
type Host = { os?: string; jobDir?: string; where?: Record<string, string> }
const WT = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe'
const FOUND = { claude: 'C:\\bin\\claude\r\nC:\\bin\\claude.exe\r\n', wt: `${WT}\r\n` }

/** Stands for the engine beneath the plugin, recording what it is asked. */
function engine(on: On, five?: Partial<SessionRateLimit>, host: Host = {}) {
  const { os = 'Windows_NT', jobDir, where = FOUND } = host
  const world: World = {
    five: five ? { kind: 'five_hour', percentUsed: 50, resetsAt: RESET, ...five } : undefined,
    submits: [],
    aborts: [],
    created: [],
    deleted: [],
    actions: [],
  }
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  on('session.usage', () => ({
    value: {
      startedAt: T0,
      context: { window: 200_000 },
      rateLimits: world.five ? [world.five] : [],
    },
  }))
  on('session.id', () => ({ value: 'abcdef1234567890' }))
  on('env.get', (_, e) => ({
    value: e.name === 'OS' ? os : e.name === 'CLAUDE_JOB_DIR' ? jobDir : undefined,
  }))
  on('command.register', () => ({ value: { command: 'limit-revive' } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.abort', (_, e) => {
    world.aborts.push(e.turnId)
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    const script = e.argv.at(-1) ?? ''
    const env = e.init?.env ?? {}
    const name = env.LR_NAME ?? ''
    const found = e.argv[0] === 'where.exe' ? (where as Record<string, string | undefined>)[e.argv[1] ?? ''] : ''
    if (script.includes('Unregister-ScheduledTask')) world.deleted.push(name)
    else if (script.includes('Register-ScheduledTask')) {
      world.created.push(name)
      // The script must start what it is handed, not a name of its own.
      world.actions.push({
        exe: script.includes('-Execute $env:LR_EXE') ? (env.LR_EXE ?? '') : 'hard-coded',
        args: env.LR_ARGS ?? '',
        cwd: env.LR_CWD ?? '',
      })
    }
    return {
      value: {
        exitCode: found === undefined ? 1 : 0,
        stdout: found ?? '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('prompt.submit', (_, e) => {
    world.submits.push(e.text)
    return { text: e.text }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  return { world, clock }
}

const start = ($: Engine) =>
  $.session.start({ cwd: 'C:\\proj', surface: 'terminal', isInteractive: true })

const measure = ($: Engine, world: World) =>
  $.session.measure({
    context: { window: 200_000 },
    rateLimits: world.five ? [world.five] : [],
    changed: ['rateLimits'],
  })

const complete = ($: Engine, turnId: string, reason: 'answer' | 'error' | 'aborted') =>
  $.turn.complete({ turnId, reason, answer: '', durationMs: 10, isAborted: reason === 'aborted' })

const typed = ($: Engine, text: string) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

test('over the threshold but the turn just finished: no timer, nothing resumed', async ($, on) => {
  const { world, clock } = engine(on, { percentUsed: 93 })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, world)
  await complete($, 't1', 'answer')

  expect(world.created).toEqual([])
  await clock.set(RESUME_AT + 10 * MIN)
  expect(world.submits).toEqual([])
})

test('resume-only: a turn that dies at the limit resumes at reset + 5 min', async ($, on) => {
  const { world, clock } = engine(on, { percentUsed: 100 })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, world)
  await complete($, 't1', 'error')

  expect(world.created).toEqual(['ClaudeLimitRevive_abcdef12'])
  expect(world.aborts).toEqual([])

  await clock.set(RESUME_AT - 1)
  expect(world.submits).toEqual([])

  // The window reset: the next reading is low and points at the next reset.
  world.five = { kind: 'five_hour', percentUsed: 0, resetsAt: '2026-11-15T19:00:00Z' }
  await clock.set(RESUME_AT)
  expect(world.submits).toEqual([
    'The usage limit has reset. Continue exactly where you left off.',
  ])
  expect(world.deleted).toEqual(['ClaudeLimitRevive_abcdef12'])
})

test('a timer armed earlier is dropped when the session later finishes', async ($, on) => {
  const { world, clock } = engine(on, { percentUsed: 100 })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await complete($, 't1', 'error')
  expect(world.created.length).toBe(1)

  // Something else (a background task notification) carries the work on to the end.
  await $.turn.start({ text: '', turnId: 't2' })
  await complete($, 't2', 'answer')

  expect(world.deleted).toEqual(['ClaudeLimitRevive_abcdef12'])
  await clock.set(RESUME_AT + MIN)
  expect(world.submits).toEqual([])
})

test('a person typing while a revive is pending cancels it', async ($, on) => {
  const { world, clock } = engine(on, { percentUsed: 100 })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await complete($, 't1', 'error')

  await typed($, 'never mind, do this instead')
  expect(world.deleted).toEqual(['ClaudeLimitRevive_abcdef12'])
  expect(world.submits).toEqual(['never mind, do this instead'])

  await clock.set(RESUME_AT + MIN)
  expect(world.submits.length).toBe(1)
})

test('stop-now aborts the running turn at the threshold and resumes later', {
  options: { mode: 'stop-now', windowsFallback: false },
}, async ($, on) => {
  const { world, clock } = engine(on, { percentUsed: 91 })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, world)
  await clock.advance(0)

  expect(world.aborts).toEqual(['t1'])
  expect(world.created).toEqual([])
  await complete($, 't1', 'aborted')

  world.five = { kind: 'five_hour', percentUsed: 1, resetsAt: '2026-11-15T19:00:00Z' }
  await clock.set(RESUME_AT)
  expect(world.submits.length).toBe(1)
})

test('finish-turn holds a prompt typed over the threshold and sends it at revive', {
  options: { mode: 'finish-turn', delayMinutes: 0, windowsFallback: false },
}, async ($, on) => {
  const { world, clock } = engine(on, { percentUsed: 95 })
  await start($)
  await measure($, world)

  const held = await typed($, 'next: write the tests')
  expect('drop' in held).toBe(true)
  expect(world.submits).toEqual([])

  world.five = { kind: 'five_hour', percentUsed: 0, resetsAt: '2026-11-15T19:00:00Z' }
  await clock.set(Date.parse(RESET))
  expect(world.submits).toEqual(['next: write the tests'])
})

test('still over at fire time with a new reset: re-armed, not submitted', {
  options: { windowsFallback: false },
}, async ($, on) => {
  const { world, clock } = engine(on, { percentUsed: 100 })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await complete($, 't1', 'error')

  const later = '2026-11-15T15:00:00Z'
  world.five = { kind: 'five_hour', percentUsed: 100, resetsAt: later }
  await clock.set(RESUME_AT)
  expect(world.submits).toEqual([])

  world.five = { kind: 'five_hour', percentUsed: 0, resetsAt: '2026-11-15T20:00:00Z' }
  await clock.set(Date.parse(later) + 5 * MIN)
  expect(world.submits.length).toBe(1)
})

test('off Windows: the session still resumes, but no scheduled task is made', async ($, on) => {
  const { world, clock } = engine(on, { percentUsed: 100 }, { os: 'Linux' })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, world)
  await complete($, 't1', 'error')

  expect(world.created).toEqual([])
  world.five = { kind: 'five_hour', percentUsed: 0, resetsAt: '2026-11-15T19:00:00Z' }
  await clock.set(RESUME_AT)
  expect(world.submits).toEqual([
    'The usage limit has reset. Continue exactly where you left off.',
  ])
  expect(world.deleted).toEqual([])
})

const PROMPT = 'The usage limit has reset. Continue exactly where you left off.'
const ID = 'abcdef1234567890'

/** A turn dies at the limit; answers what the fallback task was registered to start. */
async function limitHit($: Engine, on: On, host?: Host) {
  const { world, clock } = engine(on, { percentUsed: 100 }, host)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await complete($, 't1', 'error')
  return { world, clock }
}

test('the task starts Windows Terminal by its full path, never a bare wt.exe', async ($, on) => {
  // Task Scheduler does not search the user's PATH: a bare name ends 0x80070002.
  const { world } = await limitHit($, on)

  expect(world.actions).toEqual([
    { exe: WT, args: `-d "C:\\proj" "C:\\bin\\claude.exe" --resume ${ID} "${PROMPT}"`, cwd: 'C:\\proj' },
  ])
})

test('a background session is resumed in the background, with no terminal', async ($, on) => {
  // Its process is retired when idle, long before the reset: the in-session
  // timer is gone by then, and the task alone brings the session back.
  const { world } = await limitHit($, on, { jobDir: 'C:\\Users\\me\\.claude\\jobs\\abcdef12' })

  expect(world.actions).toEqual([
    { exe: 'C:\\bin\\claude.exe', args: `--bg --resume ${ID} "${PROMPT}"`, cwd: 'C:\\proj' },
  ])
})

test('without Windows Terminal the task starts claude itself', async ($, on) => {
  const { world } = await limitHit($, on, { where: { claude: FOUND.claude } })

  expect(world.actions).toEqual([
    { exe: 'C:\\bin\\claude.exe', args: `--resume ${ID} "${PROMPT}"`, cwd: 'C:\\proj' },
  ])
})

test('claude not on PATH: no task that could only fail, the timer still resumes', async ($, on) => {
  const { world, clock } = await limitHit($, on, { where: {} })
  expect(world.created).toEqual([])

  world.five = { kind: 'five_hour', percentUsed: 0, resetsAt: '2026-11-15T19:00:00Z' }
  await clock.set(RESUME_AT)
  expect(world.submits).toEqual([PROMPT])
})
