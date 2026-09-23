import { describe, test, expect } from 'vitest'
import { buildAgents } from '../../src/agents'
import { createConfigHandler } from '../../src/config'
import { registerForgeAgentsV2, registerForgeCommandsV2, resolveForgeConfigMaps } from '../../src/host/v2-config'
import { createFakeV2Context } from '../helpers/fake-v2-context'

function configMaps() {
  return resolveForgeConfigMaps(createConfigHandler(buildAgents()))
}

function permissionsOf(agent: { info: Record<string, any> }) {
  return agent.info.permissions as Array<{ action: string; resource: string; effect: string }>
}

describe('resolveForgeConfigMaps', () => {
  test('resolves the agent and command maps from createConfigHandler', async () => {
    const cfg = await configMaps()

    expect(Object.keys(cfg.agent)).toEqual(expect.arrayContaining(['code', 'architect', 'auditor', 'build', 'plan']))
    expect(Object.keys(cfg.command)).toEqual(expect.arrayContaining(['review', 'execute-plan', 'loop-status']))
  })
})

describe('registerForgeAgentsV2', () => {
  test('auditor agent keeps its mode, prompt, and excluded tools as deny rules', async () => {
    const cfg = await configMaps()
    const { ctx, agents } = createFakeV2Context()

    await registerForgeAgentsV2(ctx, cfg.agent)

    const auditor = agents.find((agent) => agent.id === 'auditor')
    expect(auditor).toBeDefined()
    expect(auditor?.info.mode).toBe('subagent')
    expect(auditor?.info.system).toBe(buildAgents().auditor.systemPrompt)

    const rules = permissionsOf(auditor!)
    const denies = rules.filter((rule) => rule.effect === 'deny' && rule.resource === '*').map((rule) => rule.action)
    expect(denies).toEqual(
      expect.arrayContaining([
        'edit',
        'multiedit',
        'apply_patch',
        'plan',
        'plan_enter',
        'plan_exit',
        'plan-write',
        'plan-edit',
        'execute-plan',
        'execute-goal',
        'question',
        'loop-cancel',
        'loop-status',
        'launch-group',
        'group-status',
        'group-cancel',
      ]),
    )
    expect(denies).not.toContain('write')

    const allowAll = rules.findIndex(
      (rule) => rule.action === '*' && rule.resource === '*' && rule.effect === 'allow',
    )
    expect(allowAll).toBeGreaterThanOrEqual(0)
    expect(rules.findIndex((rule) => rule.effect === 'deny')).toBeGreaterThan(allowAll)
  })

  test('maps every V1 agent field onto the V2 agent info', async () => {
    const { ctx, agents } = createFakeV2Context()

    await registerForgeAgentsV2(ctx, {
      custom: {
        description: 'custom agent',
        model: 'anthropic/claude-sonnet-4-5',
        prompt: 'system prompt',
        mode: 'primary',
        hidden: true,
        color: '#abcdef',
        variant: 'fast',
        steps: 12,
        temperature: 0.2,
        permission: { bash: 'deny', read: { 'src/**': 'allow' } },
      },
    })

    const custom = agents.find((agent) => agent.id === 'custom')
    expect(custom?.info).toMatchObject({
      name: 'custom',
      system: 'system prompt',
      description: 'custom agent',
      mode: 'primary',
      hidden: true,
      color: '#abcdef',
      steps: 12,
    })
    expect(custom?.info.model).toEqual({ id: 'claude-sonnet-4-5', providerID: 'anthropic', variant: 'fast' })
    expect(custom?.info.request.body.temperature).toBe(0.2)
    expect(permissionsOf(custom!)).toEqual(
      expect.arrayContaining([
        { action: 'shell', resource: '*', effect: 'deny' },
        { action: 'read', resource: 'src/**', effect: 'allow' },
      ]),
    )
  })

  test('removes the replaced built-in agents and defaults to code', async () => {
    const cfg = await configMaps()
    const { ctx, agents, defaultAgent } = createFakeV2Context()

    await registerForgeAgentsV2(ctx, cfg.agent)

    const expected = Object.keys(cfg.agent).filter((id) => id !== 'build' && id !== 'plan')
    expect(agents.map((agent) => agent.id)).toEqual(expected)
    expect(defaultAgent.id).toBe('code')
  })
})

describe('registerForgeCommandsV2', () => {
  test('review command switches to the auditor and substitutes $ARGUMENTS', async () => {
    const cfg = await configMaps()
    const { ctx, calls, commands } = createFakeV2Context()

    await registerForgeCommandsV2(ctx, cfg.command)

    expect(commands.map((command) => command.name)).toEqual(Object.keys(cfg.command))

    const review = commands.find((command) => command.name === 'review')
    expect(review?.description).toBe(cfg.command.review.description)

    await review?.execute({
      sessionID: 'ses_1',
      prompt: { text: 'HEAD~1', files: [{ uri: 'file:///tmp/plan.md' }] },
      delivery: 'queue',
    })

    expect(calls).toContainEqual({
      method: 'session.switchAgent',
      args: [{ sessionID: 'ses_1', agent: 'auditor' }],
    })

    const prompt = calls.find((call) => call.method === 'session.prompt')
    expect(prompt?.args[0]).toMatchObject({
      sessionID: 'ses_1',
      delivery: 'queue',
      files: [{ uri: 'file:///tmp/plan.md' }],
    })
    const text = (prompt?.args[0] as { text: string }).text
    expect(text).toContain('Input: HEAD~1')
    expect(text).not.toContain('$ARGUMENTS')
  })

  test('inserts arguments literally without interpreting replacement metacharacters', async () => {
    const cfg = await configMaps()
    const { ctx, calls, commands } = createFakeV2Context()

    await registerForgeCommandsV2(ctx, cfg.command)

    const template = cfg.command.review.template
    expect(template.split('$ARGUMENTS').length).toBeGreaterThan(1)

    const review = commands.find((command) => command.name === 'review')
    const input = 'literal $& $$ $` $\' and $ARGUMENTS end'
    await review?.execute({
      sessionID: 'ses_2',
      prompt: { text: input, files: [{ uri: 'file:///tmp/plan.md' }] },
      delivery: 'queue',
    })

    expect(calls).toContainEqual({
      method: 'session.switchAgent',
      args: [{ sessionID: 'ses_2', agent: 'auditor' }],
    })

    const prompt = calls.find((call) => call.method === 'session.prompt')
    expect(prompt?.args[0]).toMatchObject({
      sessionID: 'ses_2',
      delivery: 'queue',
      files: [{ uri: 'file:///tmp/plan.md' }],
    })
    expect((prompt?.args[0] as { text: string }).text).toBe(template.split('$ARGUMENTS').join(input))
  })
})
