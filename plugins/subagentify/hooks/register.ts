import type { Register } from 'claude-code'

const SECTION_ID = 'subagentify:routing'
const RULE = [
  '# Plan in subagents with an explicit model',
  'Whenever you plan (plan mode, or any multi-step plan), split the work into independent units and run each unit in a subagent with an explicit `model`.',
  '- opus: architecture and design, ambiguous debugging, security, cross-cutting refactors, anything that needs judgment.',
  '- sonnet: well-specified implementation, tests, docs, mechanical edits, search and exploration.',
  '- Never use haiku for delegated work.',
  'State the chosen model next to each step of the plan.',
  'Run independent units in parallel (one message, several Agent calls). The main thread integrates, reviews and verifies the results.',
].join('\n')

type Model = 'opus' | 'sonnet'
const pick = (value: unknown): Model | undefined => {
  const text = String(value ?? '').toLowerCase()
  return text.includes('opus') ? 'opus' : text.includes('sonnet') ? 'sonnet' : undefined
}

export const register: Register = (on, options) => {
  const enabled = options.enabled !== false
  const classifyFallback = options.classifyFallback !== false
  const defaultModel: Model = pick(options.defaultModel) ?? 'sonnet'

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (!enabled || result.sections.some(section => section.id === SECTION_ID)) return result
    return {
      ...result,
      sections: [...result.sections, { id: SECTION_ID, text: RULE, scope: 'session' as const }],
    }
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    // A fork inherits the parent's model; a resumed run's content is fixed.
    if (!enabled || e.fork || e.subagentType === 'fork' || e.resume) return next(e)
    if (pick(e.model)) return next(e)

    let model: Model = defaultModel
    if (classifyFallback) {
      try {
        const text = `Task: ${e.description}\n\n${e.prompt}`.slice(0, 4000)
        model = pick(await $.model.classify(text, ['opus', 'sonnet'], { model: 'haiku' })) ?? defaultModel
      } catch {
        // The default stands.
      }
    }
    return next({ ...e, model })
  }).catch(($, e, next) => next(e)) // Never block a spawn because of this plugin.
}
