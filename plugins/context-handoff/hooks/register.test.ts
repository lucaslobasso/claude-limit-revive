import { expect, test } from 'claude-code/testing'
import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const T0 = new Date(2026, 10, 20, 9, 5).getTime() // local 2026-11-20 09:05
const ID = 'abcdef1234567890'
const MODEL = 'claude-opus-5-5'
const TOOL = 'mcp__context-handoff__context_handoff'
const WT = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe'
const CLAUDE = 'C:\\bin\\claude.exe'
const FOUND = { claude: 'C:\\bin\\claude\r\nC:\\bin\\claude.exe\r\n', wt: `${WT}\r\n` }
const FILE = 'C:\\Users\\me\\.claude\\handoffs\\2026-11-20-0905-abcdef12.md'
const GOOD = '# Goal\nShip it.\n' + 'Detail that makes it self-contained. '.repeat(10)

type World = {
  percent: number | undefined
  submits: string[]
  aborts: string[]
  toasts: string[]
  /** Every command run, `where.exe` lookups left out. */
  runs: { argv: string[]; env: Record<string, string>; cwd?: string }[]
  files: Record<string, string>
  /** Exit codes of the next launches, in order; 0 when none is left. */
  exits: number[]
}

/** The machine beneath: its OS, whether the session is a background job, what `where.exe` finds. */
type Host = { os?: string; jobDir?: string; where?: Record<string, string>; model?: string }

/** Stands for the engine beneath the plugin, recording what it is asked. */
function engine(on: On, percent?: number, host: Host = {}) {
  const { os = 'Windows_NT', jobDir, where = FOUND, model = MODEL } = host
  const world: World = {
    percent,
    submits: [],
    aborts: [],
    toasts: [],
    runs: [],
    files: {},
    exits: [],
  }
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  on('session.usage', () => ({
    value: {
      startedAt: T0,
      context: { window: 200_000, ...(world.percent !== undefined ? { percent: world.percent } : {}) },
      rateLimits: [],
    },
  }))
  on('session.id', () => ({ value: ID }))
  on('session.model', () => ({ value: model }))
  on('env.get', (_, e) => ({
    value:
      e.name === 'OS'
        ? os
        : e.name === 'CLAUDE_JOB_DIR'
          ? jobDir
          : e.name === 'USERPROFILE'
            ? 'C:\\Users\\me'
            : undefined,
  }))
  on('command.register', () => ({ value: { command: 'context-handoff' } }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  const session = mock.session(on)
  on('turn.abort', (_, e) => {
    world.aborts.push(e.turnId)
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const text = world.files[e.path]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    if (argv[0] === 'where.exe') {
      const found = (where as Record<string, string | undefined>)[argv[1] ?? '']
      return {
        value: {
          exitCode: found === undefined ? 1 : 0,
          stdout: found ?? '',
          stderr: '',
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    }
    world.runs.push({ argv, env: e.init?.env ?? {}, ...(e.init?.cwd ? { cwd: e.init.cwd } : {}) })
    const exitCode = world.exits.shift() ?? 0
    return {
      value: {
        exitCode,
        stdout: '',
        stderr: exitCode ? 'error: unknown option --permission-mode' : '',
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
  const notes = () =>
    session
      .appended()
      .flatMap(row => row.message.content)
      .flatMap(block => (block.type === 'text' ? [block.text] : []))
  return { world, clock, notes }
}

const start = ($: Engine) =>
  $.session.start({ cwd: 'C:\\proj', surface: 'terminal', isInteractive: true })

const measure = ($: Engine, world: World) =>
  $.session.measure({
    context: { window: 200_000, ...(world.percent !== undefined ? { percent: world.percent } : {}) },
    rateLimits: [],
    changed: ['context'],
  })

const complete = ($: Engine, turnId: string, reason: 'answer' | 'error' | 'aborted', agentId?: string) =>
  $.turn.complete({
    turnId,
    reason,
    answer: '',
    durationMs: 10,
    isAborted: reason === 'aborted',
    ...(agentId ? { agentId } : {}),
  } as never)

const callTool = ($: Engine, input: Record<string, unknown>) =>
  $.tool.call({ tool: TOOL, ...input } as never) as Promise<{ result?: unknown; deny?: string }>

const runCommand = ($: Engine, args: string) =>
  $.command.run({
    command: 'context-handoff',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

const isHandoffPrompt = (text: string) => text.includes(FILE) && text.includes('"action": "launch"')

test('finish-turn: arms over the threshold, asks for the handoff when the turn answers', async ($, on) => {
  const { world, clock } = engine(on, 80)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, world)
  expect(world.submits).toEqual([])
  expect(world.aborts).toEqual([])

  await complete($, 't1', 'answer')
  await clock.advance(0)
  expect(world.submits.length).toBe(1)
  expect(isHandoffPrompt(world.submits[0] ?? '')).toBe(true)
  expect(world.submits[0]).toContain('context window is at 80%')
  expect(world.submits[0]).toContain('deletes it')
})

test('below the threshold nothing happens', async ($, on) => {
  const { world, clock } = engine(on, 60)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, world)
  await complete($, 't1', 'answer')
  await clock.advance(0)
  expect(world.submits).toEqual([])
})

test('stop-now aborts the running turn and asks for the handoff', {
  options: { mode: 'stop-now' },
}, async ($, on) => {
  const { world, clock } = engine(on, 76)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, world)
  await clock.advance(0)

  expect(world.aborts).toEqual(['t1'])
  expect(world.submits.length).toBe(1)
  expect(isHandoffPrompt(world.submits[0] ?? '')).toBe(true)
})

test('notify-only: a toast and one model note, nothing else', {
  options: { mode: 'notify-only' },
}, async ($, on) => {
  const { world, clock, notes } = engine(on, 90)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, world)
  await measure($, world)
  await complete($, 't1', 'answer')
  await clock.advance(0)

  expect(world.submits).toEqual([])
  expect(world.aborts).toEqual([])
  expect(notes().length).toBe(1)
  expect(notes()[0]).toContain(TOOL)
  expect(world.toasts.filter(t => t.includes('90%')).length).toBe(1)
})

test('fires once per session', async ($, on) => {
  const { world, clock } = engine(on, 80)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, world)
  await complete($, 't1', 'answer')
  await clock.advance(0)

  // The handoff turn itself, and more turns after it.
  await $.turn.start({ text: '', turnId: 't2' })
  await measure($, world)
  await complete($, 't2', 'answer')
  await $.turn.start({ text: 'more', turnId: 't3' })
  await measure($, world)
  await complete($, 't3', 'answer')
  await clock.advance(0)
  expect(world.submits.length).toBe(1)
})

test('subagent turns are ignored', {
  options: { mode: 'stop-now' },
}, async ($, on) => {
  const { world, clock } = engine(on, 85)
  await start($)
  await $.turn.start({ text: 'sub', turnId: 's1', agentId: 'a1' } as never)
  await complete($, 's1', 'answer', 'a1')
  await clock.advance(0)
  expect(world.submits).toEqual([])
  expect(world.aborts).toEqual([])

  const denied = await $.tool.call({ tool: TOOL, action: 'status', agentId: 'a1' } as never)
  expect('deny' in denied && Boolean(denied.deny)).toBe(true)
})

test('launch on Windows: Windows Terminal by full path, same model, auto mode', async ($, on) => {
  const { world } = engine(on, 50)
  await start($)
  world.files[FILE] = GOOD

  const answer = await callTool($, { action: 'launch', file: FILE })
  expect(String(answer.result)).toContain('Stop working now')
  expect(world.runs.length).toBe(1)
  const argv = world.runs[0]?.argv ?? []
  expect(argv.slice(0, 8)).toEqual([
    WT, '-d', 'C:\\proj', CLAUDE, '--model', MODEL, '--permission-mode', 'auto',
  ])
  expect(argv[8]).toContain(FILE)
  expect(argv[8]).toContain('delete the file')

  const status = await callTool($, { action: 'status' })
  expect(String(status.result)).toContain('phase launched')
})

test('launch from a background session: claude --bg, no terminal', async ($, on) => {
  const { world } = engine(on, 50, { jobDir: 'C:\\Users\\me\\.claude\\jobs\\abcdef12' })
  await start($)
  world.files[FILE] = GOOD

  await callTool($, { action: 'launch', file: FILE })
  const argv = world.runs[0]?.argv ?? []
  expect(argv.slice(0, 6)).toEqual([CLAUDE, '--bg', '--model', MODEL, '--permission-mode', 'auto'])
  expect(argv.includes(WT)).toBe(false)
})

test('without Windows Terminal claude is started in a window of its own', async ($, on) => {
  const { world } = engine(on, 50, { where: { claude: FOUND.claude } })
  await start($)
  world.files[FILE] = GOOD

  await callTool($, { action: 'launch', file: FILE })
  const run = world.runs[0]
  expect(run?.argv[0]).toBe('powershell.exe')
  expect(run?.env.CH_EXE).toBe(CLAUDE)
  expect((run?.env.CH_ARGS ?? '').startsWith(`--model ${MODEL} --permission-mode auto "Continue`)).toBe(true)
})

test('off Windows: nothing is run, the command is returned', async ($, on) => {
  const { world } = engine(on, 50, { os: 'Linux' })
  await start($)
  world.files[FILE] = GOOD

  const answer = String((await callTool($, { action: 'launch', file: FILE })).result)
  expect(world.runs).toEqual([])
  expect(answer).toContain(`claude --model ${MODEL} --permission-mode auto "Continue`)
  expect(answer).toContain(FILE)
})

test('autoLaunch off: the command is returned on Windows too', {
  options: { autoLaunch: false },
}, async ($, on) => {
  const { world } = engine(on, 50)
  await start($)
  world.files[FILE] = GOOD
  const answer = String((await callTool($, { action: 'launch', file: FILE })).result)
  expect(world.runs).toEqual([])
  expect(answer).toContain('claude --model')
})

test('a missing or short handoff file is refused', async ($, on) => {
  const { world } = engine(on, 50)
  await start($)

  const missing = String((await callTool($, { action: 'launch', file: FILE })).result)
  expect(missing).toContain('Refused')
  world.files[FILE] = '# Goal\nShip it.'
  const short = String((await callTool($, { action: 'launch', file: FILE })).result)
  expect(short).toContain('too short')
  expect(world.runs).toEqual([])
})

test('a failed launch is retried once without --permission-mode', async ($, on) => {
  const { world } = engine(on, 50)
  await start($)
  world.files[FILE] = GOOD
  world.exits = [1, 0]

  const answer = String((await callTool($, { action: 'launch', file: FILE })).result)
  expect(world.runs.length).toBe(2)
  expect(world.runs[0]?.argv.includes('--permission-mode')).toBe(true)
  expect(world.runs[1]?.argv.includes('--permission-mode')).toBe(false)
  expect(answer).toContain('was refused')
  expect(answer).toContain('Stop working now')
})

test('a launch that fails twice keeps the file and returns the command', async ($, on) => {
  const { world } = engine(on, 50)
  await start($)
  world.files[FILE] = GOOD
  world.exits = [1, 1]

  const answer = String((await callTool($, { action: 'launch', file: FILE })).result)
  expect(answer).toContain('was not started')
  expect(answer).toContain(`stays at ${FILE}`)
  const status = String((await callTool($, { action: 'status' })).result)
  expect(status).not.toContain('phase launched')
})

test('cancel drops an armed handoff until the context falls below the threshold', async ($, on) => {
  const { world, clock } = engine(on, 80)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await measure($, world)
  await runCommand($, 'cancel')
  await complete($, 't1', 'answer')
  await clock.advance(0)
  expect(world.submits).toEqual([])

  // Still over: no trigger.
  await $.turn.start({ text: 'go', turnId: 't2' })
  await measure($, world)
  await complete($, 't2', 'answer')
  await clock.advance(0)
  expect(world.submits).toEqual([])

  // A compaction freed room, then it filled again: it triggers once more.
  world.percent = 30
  await measure($, world)
  world.percent = 78
  await $.turn.start({ text: 'go', turnId: 't3' })
  await measure($, world)
  await complete($, 't3', 'answer')
  await clock.advance(0)
  expect(world.submits.length).toBe(1)
})

test('/context-handoff now asks for the handoff at once', async ($, on) => {
  const { world, clock } = engine(on, 20)
  await start($)
  await runCommand($, 'now')
  await clock.advance(0)
  expect(world.submits.length).toBe(1)
  expect(isHandoffPrompt(world.submits[0] ?? '')).toBe(true)
})

/** The `--model` the launch passes for what `$.session.model()` answers; undefined when none. */
async function launchedModel($: Engine, on: On, model: string) {
  const { world } = engine(on, 50, { model })
  await start($)
  world.files[FILE] = GOOD
  const answer = String((await callTool($, { action: 'launch', file: FILE })).result)
  const argv = world.runs[0]?.argv ?? []
  const at = argv.indexOf('--model')
  return { model: at < 0 ? undefined : argv[at + 1], answer }
}

test('a model id or alias is passed as is', async ($, on) => {
  expect((await launchedModel($, on, 'sonnet[1m]')).model).toBe('sonnet[1m]')
})

test('a display name becomes the full model id', async ($, on) => {
  expect((await launchedModel($, on, 'Opus 5.5')).model).toBe('claude-opus-5-5')
})

test('a 1M-context display name keeps the [1m] suffix', async ($, on) => {
  expect((await launchedModel($, on, 'Claude Sonnet 5.5 (1M context)')).model).toBe(
    'claude-sonnet-5-5[1m]',
  )
})

test('a display name without a version falls back to the family alias', async ($, on) => {
  expect((await launchedModel($, on, 'Haiku (latest)')).model).toBe('haiku')
})

test('an unknown model name: no --model, and the result says so', async ($, on) => {
  const { model, answer } = await launchedModel($, on, 'Some Custom Model')
  expect(model).toBe(undefined)
  expect(answer).toContain('--model was left out')
})
