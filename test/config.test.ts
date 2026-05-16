import { describe, test, expect } from 'bun:test'
import { createConfigHandler } from '../src/config'
import { buildAgents } from '../src/agents'

const agents = buildAgents()

describe('createConfigHandler', () => {
  describe('config merge behavior', () => {
    test('permission enablement is additive to existing permission config', async () => {
      const configHandler = createConfigHandler(agents)

      const config: Record<string, unknown> = {
        agent: {
          explore: {
            permission: {
              'existing-tool': 'allow',
            },
          },
        },
      }

      await configHandler(config)

      const exploreConfig = config.agent as Record<string, unknown>
      const explore = exploreConfig?.explore as Record<string, unknown>

      expect(explore).toBeDefined()
      const permission = explore.permission as Record<string, string>
      expect(permission['existing-tool']).toBe('allow')
      expect(permission['graph-query']).toBeUndefined()
      expect(permission['graph-symbols']).toBeUndefined()
      expect(permission['graph-analyze']).toBeUndefined()
    })

    test('built-in agents without enhancement are hidden if in REPLACED_BUILTIN_AGENTS', async () => {
      const configHandler = createConfigHandler(agents)
      const config: Record<string, unknown> = {}

      await configHandler(config)

      const agentConfigs = config.agent as Record<string, unknown>

      expect(agentConfigs.build).toBeDefined()
      expect((agentConfigs.build as Record<string, unknown>).hidden).toBe(true)
      expect(agentConfigs.plan).toBeDefined()
      expect((agentConfigs.plan as Record<string, unknown>).hidden).toBe(true)
    })

    test('code agent tools include review-delete: false by default', async () => {
      const configHandler = createConfigHandler(agents)
      const config: Record<string, unknown> = {}

      await configHandler(config)

      const agentConfigs = config.agent as Record<string, unknown>
      const code = agentConfigs.code as Record<string, unknown>
      const tools = code.tools as Record<string, boolean>

      expect(tools).toBeDefined()
      expect(tools['review-delete']).toBe(false)
    })

    test('code agent is available as both primary and subagent', async () => {
      const configHandler = createConfigHandler(agents)
      const config: Record<string, unknown> = {}

      await configHandler(config)

      const agentConfigs = config.agent as Record<string, unknown>
      const code = agentConfigs.code as Record<string, unknown>

      expect(code.mode).toBe('all')
    })

    test('code and architect agent config does not install loop session permission overrides', async () => {
      const configHandler = createConfigHandler(agents)
      const config: Record<string, unknown> = {}

      await configHandler(config)

      const agentConfigs = config.agent as Record<string, unknown>
      const code = agentConfigs.code as Record<string, unknown>
      const architect = agentConfigs.architect as Record<string, unknown>
      const codePermission = code.permission as Record<string, string>
      const architectPermission = architect.permission as Record<string, string>

      expect(Object.keys(codePermission).sort()).toEqual([
        'plan',
        'plan_enter',
        'plan_exit',
        'question',
        'review-delete',
        'review-write',
      ].sort())
      expect(Object.keys(architectPermission).sort()).toEqual([
        'plan',
        'plan_enter',
        'plan_exit',
        'question',
      ].sort())

      for (const permission of [codePermission, architectPermission]) {
        expect(permission['*']).toBeUndefined()
        expect(permission.external_directory).toBeUndefined()
        expect(permission.bash).toBeUndefined()
        expect(permission.loop).toBeUndefined()
        expect(permission['loop-cancel']).toBeUndefined()
        expect(permission['loop-status']).toBeUndefined()
      }
    })

    test('code agent excluded tools are mirrored to permission: deny (opencode enforces via permission, not tools)', async () => {
      const configHandler = createConfigHandler(agents)
      const config: Record<string, unknown> = {}

      await configHandler(config)

      const agentConfigs = config.agent as Record<string, unknown>
      const code = agentConfigs.code as Record<string, unknown>
      const permission = code.permission as Record<string, string>

      expect(permission).toBeDefined()
      for (const tool of ['review-write', 'review-delete', 'plan', 'plan_enter', 'plan_exit']) {
        expect(permission[tool]).toBe('deny')
      }
      expect(permission.loop).toBeUndefined()
    })

    test('user tool override cannot flip built-in permission deny', async () => {
      const configHandler = createConfigHandler(agents)
      const config: Record<string, unknown> = {
        agent: {
          code: {
            tools: {
              'review-delete': true,
            },
          },
        },
      }

      await configHandler(config)

      const agentConfigs = config.agent as Record<string, unknown>
      const code = agentConfigs.code as Record<string, unknown>
      const permission = code.permission as Record<string, string>

      expect(permission['review-delete']).toBe('deny')
      expect(permission['plan-execute']).toBeUndefined()
    })

    test('user tool override preserves built-in excludes during merge', async () => {
      const configHandler = createConfigHandler(agents)
      const config: Record<string, unknown> = {
        agent: {
          code: {
            tools: {
              bash: true,
            },
          },
        },
      }

      await configHandler(config)

      const agentConfigs = config.agent as Record<string, unknown>
      const code = agentConfigs.code as Record<string, unknown>
      const tools = code.tools as Record<string, boolean>

      expect(tools['review-delete']).toBe(false)
      expect(tools.bash).toBe(true)
    })

    test('explicit user override cannot override built-in tool denies', async () => {
      const configHandler = createConfigHandler(agents)
      const config: Record<string, unknown> = {
        agent: {
          code: {
            tools: {
              'review-delete': true,
            },
          },
        },
      }

      await configHandler(config)

      const agentConfigs = config.agent as Record<string, unknown>
      const code = agentConfigs.code as Record<string, unknown>
      const tools = code.tools as Record<string, boolean>

      expect(tools['review-delete']).toBe(false)
    })

    test('user wildcard permission cannot outrank built-in permission denies', async () => {
      const configHandler = createConfigHandler(agents)
      const config: Record<string, unknown> = {
        agent: {
          code: {
            permission: {
              '*': 'allow',
              bash: 'ask',
            },
            tools: {
              'review-delete': true,
            },
          },
        },
      }

      await configHandler(config)

      const agentConfigs = config.agent as Record<string, unknown>
      const code = agentConfigs.code as Record<string, unknown>
      const permission = code.permission as Record<string, string>
      const keys = Object.keys(permission)
      const wildcardIndex = keys.indexOf('*')

      expect(permission['*']).toBe('allow')
      expect(permission.bash).toBe('ask')
      expect(wildcardIndex).toBeGreaterThanOrEqual(0)

      for (const tool of ['review-write', 'review-delete', 'plan', 'plan_enter', 'plan_exit']) {
        expect(permission[tool]).toBe('deny')
        expect(keys.indexOf(tool)).toBeGreaterThan(wildcardIndex)
      }
      expect(permission.loop).toBeUndefined()
    })

    test('auditor agent retains review-delete access', async () => {
      const configHandler = createConfigHandler(agents)
      const config: Record<string, unknown> = {}

      await configHandler(config)

      const agentConfigs = config.agent as Record<string, unknown>
      const auditor = agentConfigs.auditor as Record<string, unknown>

      expect(auditor).toBeDefined()
      const tools = auditor.tools as Record<string, boolean> | undefined
      if (tools) {
        expect(tools['review-delete']).not.toBe(false)
      }
    })

    test('registers review-plan command with auditor agent', async () => {
      const configHandler = createConfigHandler(agents)
      const config: Record<string, unknown> = {}

      await configHandler(config)

      const commands = config.command as Record<string, Record<string, unknown>>
      const reviewPlan = commands['review-plan']

      expect(reviewPlan).toBeDefined()
      expect(reviewPlan.agent).toBe('auditor')
      expect(reviewPlan.subtask).toBe(true)
      expect(reviewPlan.template).toContain('plan-read')
      expect(reviewPlan.template).toContain('Do not use loop management tools')
      expect(reviewPlan.template).toContain('completed implementation')
      expect(reviewPlan.template).toContain('recent: true')
      expect(reviewPlan.template).not.toContain('loop-status')
      expect(reviewPlan.description).not.toContain('before execution')
      expect(reviewPlan.description).toContain('completed implementation')
    })
  })
})
