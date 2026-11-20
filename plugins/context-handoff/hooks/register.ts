import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Handoff } from '../types'

const PLUGIN = 'context-handoff'
const TOOL = 'context_handoff'
/** A handoff file shorter than this cannot be self-contained. */
const MIN_FILE_CHARS = 200
const LAUNCH_TIMEOUT_MS = 30_000
const MODES = ['finish-turn', 'stop-now', 'notify-only'] as const
type Mode = (typeof MODES)[number]
const PERMISSION_MODES = ['auto', 'acceptEdits', 'manual', 'bypassPermissions', 'dontAsk', 'plan']

const IDLE: Handoff = { phase: 'idle' }
const handoffAtom = atom({ plugin: 'context-handoff', key: 'handoff' } as const, IDLE, {
  shape: 'handoff-1',
})
const overrideAtom = atom({ plugin: 'context-handoff', key: 'override' } as const, false, {
  shape: 'override-1',
})

// Starts a console program in a window of its own and returns at once, so the
// new session is not a child the run waits on (and kills at its timeout).
// Values arrive through env vars, never through string-built PowerShell.
const PS_START =
  "$ErrorActionPreference = 'Stop'; Start-Process -FilePath $env:CH_EXE -ArgumentList $env:CH_ARGS -WorkingDirectory $env:CH_CWD"

const num = (value: unknown, fallback: number) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
const pad = (n: number) => String(n).padStart(2, '0')
/** Local `yyyy-mm-dd-hhmm`, the handoff file's prefix. */
const stamp = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}
const isAbsolute = (path: string) => /^([A-Za-z]:[\\/]|[\\/])/.test(path)
/**
 * Safe inside a quoted argument of a wt.exe line: no quotes, no `;` (wt's
 * separator), no backslash left at the end to swallow the closing quote.
 */
const forCommandLine = (text: string) =>
  text.replace(/["`;]/g, '').replace(/\s+/g, ' ').trim().slice(0, 500).replace(/\\+$/, '')
/** Of `where.exe`'s matches, one that can be started: an .exe, else a .cmd or .bat. */
const pickExecutable = (stdout: string) => {
  const found = stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  return (
    found.find(path => /\.exe$/i.test(path)) ?? found.find(path => /\.(cmd|bat)$/i.test(path))
  )
}
/**
 * A model as `--model` takes it. `$.session.model()` answers as /model shows
 * it, which may be a display name ("Opus 5.5", "Claude Sonnet 5.5 (1M
 * context)"): an id or alias is kept, a display name becomes the full id when
 * family and version parse ("claude-opus-5-5", "[1m]" for 1M context), else
 * the family alias; undefined when nothing matches.
 */
function cliModel(raw: string | undefined): string | undefined {
  const text = (raw ?? '').trim()
  if (!text) return undefined
  if (/^[a-z0-9][a-z0-9.\-_\[\]]*$/.test(text)) return text
  const lower = text.toLowerCase()
  const match = /\b(opus|sonnet|haiku|fable)\b(?:\s+(\d+(?:\.\d+)*)\b)?/.exec(lower)
  if (!match) return undefined
  const [, family, version] = match
  const suffix = /\b1\s*m\b/.test(lower) ? '[1m]' : ''
  return version ? `claude-${family}-${version.replace(/\./g, '-')}${suffix}` : family
}
/** One argument as a shell line shows it: quoted when it holds a space. */
const shown = (arg: string) => (/[\s"]/.test(arg) ? `"${arg}"` : arg)

// Fixed per activation: register() fills it, and a change of options reloads.
let cfg = {
  threshold: 75,
  mode: 'finish-turn' as Mode,
  handoffDir: '',
  permissionMode: 'auto',
  sameModel: true,
  autoLaunch: true,
}

// The launch uses Windows Terminal / Start-Process, so it only runs on Windows.
let isWindows = false
// A background session (agent view, `claude --bg`) has no window: its
// successor is started in the background too.
let isBackground = false

// Module variables start over on a reload; the durable parts live in $.state.
let mainTurnId: string | undefined
let cwd = ''
let toolName = `mcp__${PLUGIN}__${TOOL}`
let lastPercent: number | undefined
const exePaths = new Map<string, string | undefined>()

const sep = () => (isWindows ? '\\' : '/')
const join = (dir: string, name: string) => dir.replace(/[\\/]+$/, '') + sep() + name

async function setHandoff($: EngineInterface, value: Handoff) {
  await update($, handoffAtom, () => value)
  showStatus($, value)
}

function showStatus($: EngineInterface, handoff: Handoff) {
  $.ui.status(
    handoff.phase === 'armed'
      ? `↪ handoff after this turn (context ${handoff.percent ?? '?'}%)`
      : handoff.phase === 'writing'
        ? '↪ writing handoff…'
        : handoff.phase === 'launched'
          ? `↪ handed off → ${handoff.file ?? ''}`
          : undefined,
  )
}

async function contextPercent($: EngineInterface) {
  try {
    lastPercent = (await $.session.usage()).context.percent ?? lastPercent
  } catch {
    // Keep the last reading.
  }
  return lastPercent
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

async function handoffDir($: EngineInterface) {
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
  const dir = cfg.handoffDir.trim()
  if (!dir) return join(join(home, '.claude'), 'handoffs')
  return /^~(?=[\\/]|$)/.test(dir) ? home + dir.slice(1) : dir
}

async function newFilePath($: EngineInterface) {
  const sessionId = await $.session.id()
  return join(await handoffDir($), `${stamp(await $.clock.now())}-${sessionId.slice(0, 8)}.md`)
}

// ---- The handoff prompt ---------------------------------------------------

function handoffPrompt(file: string, percent: number | undefined) {
  return [
    `The context window is at ${percent ?? '?'}%. Hand this work off to a fresh session now.`,
    '',
    `1. Write a handoff file at ${file} (create the folder if needed) with these sections:`,
    '   - Goal',
    '   - Done so far',
    '   - In progress (exact state)',
    '   - Next steps (ordered)',
    '   - Key files and paths',
    '   - Decisions and constraints (including user preferences stated this session)',
    '   - Open questions',
    '   - How to verify',
    '   - Repo/branch/worktree',
    '   The file must be self-contained: the new session has none of this context, only the file.',
    '   Use absolute paths, exact commands and exact names; do not refer to "above" or "earlier".',
    `2. Then call the ${toolName} tool with {"action": "launch", "file": "${file}"}.`,
    '',
    'The new session reads the file and then deletes it, so put everything it needs in the file.',
  ].join('\n')
}

async function submitHandoff($: EngineInterface, percent: number | undefined) {
  const file = await newFilePath($)
  await setHandoff($, { phase: 'writing', file, ...(percent !== undefined ? { percent } : {}) })
  $.ui.toast(`${PLUGIN}: context at ${percent ?? '?'}%; writing a handoff file.`)
  await $.prompt.submit({ text: handoffPrompt(file, percent) })
}

async function stopAndHandoff($: EngineInterface, turnId: string, percent: number) {
  await $.turn.abort({ turnId })
  await submitHandoff($, percent)
}

async function notify($: EngineInterface, percent: number) {
  await update($, overrideAtom, () => true)
  $.ui.toast(`${PLUGIN}: context at ${percent}%. Ask Claude to hand off to a fresh session.`)
  try {
    await $.session.append({
      message: {
        type: 'user',
        content: [
          {
            type: 'text',
            text:
              `[${PLUGIN}] The context window is at ${percent}%. If the user wants to continue in a fresh ` +
              `session, write a self-contained handoff file and call the ${toolName} tool ` +
              '(action "launch") with its path.',
          },
        ],
      },
    })
  } catch {
    // The toast still told the person.
  }
}

/**
 * Acts on a reading of the main loop's context: below the threshold it lifts
 * an override and drops an armed handoff (a compaction freed room); over it,
 * once per session, it starts the handoff the mode asks for.
 */
async function check($: EngineInterface, percent: number | undefined, turnEnded: boolean) {
  if (percent === undefined) return
  const handoff = await read($, handoffAtom)

  if (percent < cfg.threshold) {
    if (await read($, overrideAtom)) await update($, overrideAtom, () => false)
    if (handoff.phase === 'armed') await setHandoff($, IDLE)
    return
  }
  if (handoff.phase !== 'idle' || (await read($, overrideAtom))) {
    // Armed: it fires at the end of the turn, not here.
    if (handoff.phase === 'armed' && turnEnded) void submitHandoff($, handoff.percent ?? percent)
    return
  }

  if (cfg.mode === 'notify-only') return notify($, percent)
  const turnId = mainTurnId
  if (turnEnded || turnId === undefined) {
    // Nothing running: no turn to wait for or to stop.
    await setHandoff($, { phase: 'writing', percent })
    void submitHandoff($, percent)
  } else if (cfg.mode === 'finish-turn') {
    await setHandoff($, { phase: 'armed', percent })
  } else {
    await setHandoff($, { phase: 'writing', percent })
    // Leave the measure first: the abort ends the turn this hook sits in.
    void stopAndHandoff($, turnId, percent)
  }
}

// ---- Launching the new session -----------------------------------------

type Launch = { exe: string; args: string[]; viaStartProcess?: boolean }

function claudeArgs(model: string | undefined, permissionMode: string | undefined, prompt: string) {
  return [
    ...(model ? ['--model', model] : []),
    ...(permissionMode ? ['--permission-mode', permissionMode] : []),
    prompt,
  ]
}

/** What starts the new session, every executable by its full path; undefined when claude is not found. */
async function launchFor(
  $: EngineInterface,
  model: string | undefined,
  permissionMode: string | undefined,
  prompt: string,
): Promise<Launch | undefined> {
  const claude = await resolveExe($, 'claude')
  if (!claude) return undefined
  const args = claudeArgs(model, permissionMode, prompt)
  if (isBackground) return { exe: claude, args: ['--bg', ...args] }
  const wt = await resolveExe($, 'wt')
  return wt
    ? { exe: wt, args: ['-d', cwd, claude, ...args] }
    : { exe: claude, args, viaStartProcess: true }
}

async function runLaunch($: EngineInterface, launch: Launch) {
  try {
    const run = launch.viaStartProcess
      ? await $.process.run(
          ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', PS_START],
          {
            env: { CH_EXE: launch.exe, CH_ARGS: launch.args.map(shown).join(' '), CH_CWD: cwd },
            timeoutMs: LAUNCH_TIMEOUT_MS,
          },
        )
      : await $.process.run([launch.exe, ...launch.args], { cwd, timeoutMs: LAUNCH_TIMEOUT_MS })
    return {
      ok: run.exitCode === 0,
      why: run.exitCode === 0 ? '' : `exit ${run.exitCode}: ${run.stderr.trim().split(/\r?\n/)[0] ?? ''}`,
    }
  } catch (error) {
    return { ok: false, why: String(error) }
  }
}

/** The command for the person to run by hand. */
function manualCommand(model: string | undefined, permissionMode: string | undefined, prompt: string) {
  const line = ['claude', ...(isBackground ? ['--bg'] : []), ...claudeArgs(model, permissionMode, prompt)]
    .map(shown)
    .join(' ')
  return `cd ${shown(cwd)} && ${line}`
}

async function launch($: EngineInterface, rawFile: unknown): Promise<string> {
  const current = await read($, handoffAtom)
  if (current.phase === 'launched') {
    return `Already handed off to ${current.file ?? 'a new session'}. Stop working now; /${PLUGIN} cancel resets this.`
  }
  if (typeof rawFile !== 'string' || !rawFile.trim()) {
    return 'Refused: pass "file", the path of the handoff file you wrote.'
  }
  const file = isAbsolute(rawFile.trim()) ? rawFile.trim() : join(cwd, rawFile.trim())
  let text: string
  try {
    text = await $.fs.read(file)
  } catch {
    return `Refused: ${file} does not exist. Write the handoff file first, then call launch again.`
  }
  if (text.trim().length < MIN_FILE_CHARS) {
    return `Refused: ${file} is too short to be self-contained (under ${MIN_FILE_CHARS} characters). Complete it, then call launch again.`
  }

  const prompt = forCommandLine(
    `Continue the work described in the handoff file ${file}. Read it first, then delete the file, then continue.`,
  )
  let model: string | undefined
  let modelNote = ''
  if (cfg.sameModel) {
    let shownModel = ''
    try {
      shownModel = (await $.session.model()).trim()
    } catch {
      // The new session takes its default model.
    }
    model = cliModel(shownModel)
    if (!model) {
      modelNote = ` The model "${shownModel}" could not be turned into a --model value, so --model was left out: the new session uses its default model.`
    }
  }
  let permissionMode: string | undefined = cfg.permissionMode
  await update($, handoffAtom, (h): Handoff => ({ ...h, phase: 'writing', file }))

  const giveCommand = (why: string) => {
    const command = manualCommand(model, permissionMode, prompt)
    return (
      `The new session was not started (${why}). The handoff file stays at ${file}. ` +
      `Give the user this command to run, then stop working:\n${command}`
    )
  }
  if (!cfg.autoLaunch) return giveCommand('autoLaunch is off')
  if (!isWindows) return giveCommand('automatic launch is Windows-only')

  let action = await launchFor($, model, permissionMode, prompt)
  if (!action) return giveCommand('claude was not found on PATH')
  let result = await runLaunch($, action)
  let note = ''
  if (!result.ok && permissionMode) {
    // An older CLI, or a mode this account cannot use: try once without it.
    const failed = result.why
    permissionMode = undefined
    action = (await launchFor($, model, permissionMode, prompt)) ?? action
    result = await runLaunch($, action)
    if (result.ok) {
      note = ` --permission-mode ${cfg.permissionMode} was refused (${failed}); it was started without it, in its default mode.`
    }
  }
  if (!result.ok) return giveCommand(`the launch failed: ${result.why}`)

  await setHandoff($, { ...(await read($, handoffAtom)), phase: 'launched', file })
  $.ui.toast(`${PLUGIN}: handed off to a new session → ${file}`)
  return (
    `A new session was started${model ? ` on ${model}` : ''} and continues from ${file}.` +
    note +
    modelNote +
    ' Stop working now: tell the user in one line that the work continues in the new session, and do nothing else.'
  )
}

async function statusText($: EngineInterface) {
  const handoff = await read($, handoffAtom)
  const percent = await contextPercent($)
  const lines = [
    `mode ${cfg.mode}, threshold ${cfg.threshold}%, context ${percent ?? '?'}%`,
    `phase ${handoff.phase}` + (handoff.file ? `, file ${handoff.file}` : ''),
    `new session: ${cfg.autoLaunch ? (isWindows ? 'launched automatically' : 'command only (not Windows)') : 'command only'}` +
      `, --permission-mode ${cfg.permissionMode}${cfg.sameModel ? ', same model' : ''}${isBackground ? ', background session' : ''}`,
  ]
  if (await read($, overrideAtom)) lines.push('paused until the context falls below the threshold')
  return lines.join('\n')
}

async function cancel($: EngineInterface) {
  const handoff = await read($, handoffAtom)
  await setHandoff($, IDLE)
  await update($, overrideAtom, () => true)
  return handoff.phase === 'idle'
    ? 'Nothing in progress; no trigger until the context falls below the threshold.'
    : 'Handoff cancelled; no trigger until the context falls below the threshold (after a compaction).'
}

const TOOL_DESCRIPTION =
  'Hands this work off to a fresh Claude Code session. Use it when the user asks to hand off, or to continue ' +
  'in a new or fresh session, or when the context-handoff plugin asks you to. First write a self-contained ' +
  'handoff file (Goal; Done so far; In progress; Next steps; Key files and paths; Decisions and constraints; ' +
  'Open questions; How to verify; Repo/branch/worktree), then call {action: "launch", file: "<absolute path>"}: ' +
  'it starts the new session, which reads the file and deletes it. After a successful launch, stop working. ' +
  '"status" reports the state; "cancel" stops an automatic handoff.'

export const register: Register = (on, options) => {
  cfg = {
    threshold: num(options.thresholdPercent, 75),
    mode: MODES.includes(options.mode as Mode) ? (options.mode as Mode) : 'finish-turn',
    handoffDir: typeof options.handoffDir === 'string' ? options.handoffDir : '',
    permissionMode: PERMISSION_MODES.includes(String(options.permissionMode))
      ? String(options.permissionMode)
      : 'auto',
    sameModel: options.sameModel !== false,
    autoLaunch: options.autoLaunch !== false,
  }

  // ---- Hooks -----------------------------------------------------------------

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    isWindows = (await $.env.get('OS')) === 'Windows_NT'
    isBackground = Boolean(await $.env.get('CLAUDE_JOB_DIR'))
    await $.command.register({
      name: PLUGIN,
      description: 'Hand off to a fresh session when context fills: status | now | cancel',
      argumentHint: '[status|now|cancel]',
      immediate: true,
    })
    try {
      const { tool } = await $.tool.register({
        name: TOOL,
        description: TOOL_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['launch', 'status', 'cancel'] },
            file: { type: 'string', description: 'launch: the handoff file, absolute path' },
          },
          required: ['action'],
        },
        isDeferred: false,
      })
      toolName = tool
    } catch {
      // Keep the expected name; the command still works.
    }
    showStatus($, await read($, handoffAtom))
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
      // Leave the hook first: the handoff prompt is a turn of its own.
      const percent = await contextPercent($)
      void check($, percent, true)
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.context.percent !== undefined) lastPercent = e.context.percent
    await check($, e.context.percent, false)
    return result
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool !== toolName) return next(e)
    if (e.agentId !== undefined) {
      return { deny: `${TOOL} is for the main session only; a subagent cannot hand off.` }
    }
    const input = e as unknown as { action?: unknown; file?: unknown }
    const action = String(input.action ?? '').toLowerCase()
    if (action === 'launch') return { result: await launch($, input.file) }
    if (action === 'status') return { result: await statusText($) }
    if (action === 'cancel') return { result: await cancel($) }
    return { deny: 'Unknown action: use launch, status or cancel.' }
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await setHandoff($, IDLE)
      await update($, overrideAtom, () => false)
    }
    return next(e)
  })

  on('command.run', { command: PLUGIN }, async ($, e) => {
    const action = e.args.trim().toLowerCase() || 'status'
    if (action === 'cancel') return { text: await cancel($) }
    if (action === 'now') {
      const handoff = await read($, handoffAtom)
      if (handoff.phase === 'writing' || handoff.phase === 'launched') {
        return { text: `A handoff is already ${handoff.phase === 'writing' ? 'being written' : 'done'}; /${PLUGIN} cancel first.` }
      }
      void submitHandoff($, await contextPercent($))
      return { text: 'Asking Claude to write the handoff file now.' }
    }
    return { text: await statusText($) }
  }).catch(() => ({ text: `${PLUGIN}: the command failed; see claude --debug.` }))
}
