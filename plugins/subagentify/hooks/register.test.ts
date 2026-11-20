import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

/** Stands for the engine beneath: records the model each spawn reaches and each classify call. */
function engine(on: On, classify: () => string | undefined = () => 'opus') {
  const world = { spawned: [] as (string | undefined)[], classified: [] as string[], fail: false }
  on('model.classify', (_, e) => {
    world.classified.push(e.text)
    if (world.fail) throw new Error('classifier down')
    return { value: classify() }
  })
  on('agent.spawn', (_, e) => {
    world.spawned.push(e.model)
    return { model: e.model ?? 'inherit', agentId: 'a1' }
  })
  on('prompt.compose', (_, e) => ({
    sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' as const }],
  }))
  return world
}

const COMPOSE = {
  model: 'claude-opus-4-5', promptModel: 'claude-opus-4-5', surfaces: [], tools: [], outputStyle: null, traits: [],
} as const

const spawn = ($: Parameters<Parameters<typeof test>[2]>[0], model?: string, extra: object = {}) =>
  $.agent.spawn({ prompt: 'Add a unit test for parse()', description: 'write tests', ...(model ? { model } : {}), ...extra })

test('the planning rule is appended as a session section', async ($, on) => {
  engine(on)
  const { sections } = await $.prompt.compose(COMPOSE)
  expect(sections.map(s => s.id)).toEqual(['intro', 'subagentify:routing'])
  const rule = sections[1]!
  expect(rule.scope).toBe('session')
  expect(rule.text).toContain('opus')
  expect(rule.text).toContain('sonnet')
})

test('a subagent with no model is classified', async ($, on) => {
  const world = engine(on, () => 'opus')
  await spawn($)
  expect(world.spawned).toEqual(['opus'])
  expect(world.classified.length).toBe(1)
  expect(world.classified[0]).toContain('write tests')
})

test('haiku is replaced', async ($, on) => {
  const world = engine(on, () => 'sonnet')
  await spawn($, 'haiku')
  expect(world.spawned).toEqual(['sonnet'])
})

test('an explicit opus or sonnet stays, with no classifier call', async ($, on) => {
  const world = engine(on)
  await spawn($, 'opus')
  await spawn($, 'claude-sonnet-4-5')
  expect(world.spawned).toEqual(['opus', 'claude-sonnet-4-5'])
  expect(world.classified).toEqual([])
})

test('a fork is left alone', async ($, on) => {
  const world = engine(on)
  await spawn($, undefined, { subagentType: 'fork' })
  expect(world.spawned).toEqual([undefined])
  expect(world.classified).toEqual([])
})

test('a classifier error falls back to the default model', async ($, on) => {
  const world = engine(on)
  world.fail = true
  await spawn($)
  expect(world.spawned).toEqual(['sonnet'])
})

test('defaultModel opus is used when classification is off', {
  options: { classifyFallback: false, defaultModel: 'opus' },
}, async ($, on) => {
  const world = engine(on)
  await spawn($, 'haiku')
  expect(world.spawned).toEqual(['opus'])
  expect(world.classified).toEqual([])
})

test('enabled false passes both hooks through', {
  options: { enabled: false },
}, async ($, on) => {
  const world = engine(on)
  await spawn($, 'haiku')
  expect(world.spawned).toEqual(['haiku'])
  expect(world.classified).toEqual([])
  const { sections } = await $.prompt.compose(COMPOSE)
  expect(sections.map(s => s.id)).toEqual(['intro'])
})
