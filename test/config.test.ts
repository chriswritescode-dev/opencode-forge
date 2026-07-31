import { describe, test, expect } from 'vitest'
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

    test('code agent config does not install loop session permission overrides', async () => {
      const configHandler = createConfigHandler(agents)
      const config: Record<string, unknown> = {}

      await configHandler(config)

      const agentConfigs = config.agent as Record<string, unknown>
      const code = agentConfigs.code as Record<string, unknown>
      const codePermission = code.permission as Record<string, string>

      expect(Object.keys(codePermission).sort()).toEqual([
        'plan',
        'plan-edit',
        'plan-write',
        'plan_enter',
        'plan_exit',
        'question',
        'review-delete',
        'review-write',
      ].sort())

      expect(codePermission['*']).toBeUndefined()
      expect(codePermission.external_directory).toBeUndefined()
      expect(codePermission.bash).toBeUndefined()
      expect(codePermission.loop).toBeUndefined()
      expect(codePermission['loop-cancel']).toBeUndefined()
      expect(codePermission['loop-status']).toBeUndefined()
    })

    test('architect agents deny mutation tools while retaining Bash and plan authoring access', async () => {
      const configHandler = createConfigHandler(agents)
      const config: Record<string, unknown> = {}

      await configHandler(config)

      const agentConfigs = config.agent as Record<string, unknown>
      const architect = agentConfigs.architect as Record<string, unknown>
      const architectAuto = agentConfigs['architect-auto'] as Record<string, unknown>
      const architectTools = architect.tools as Record<string, boolean>
      const architectAutoTools = architectAuto.tools as Record<string, boolean>
      const architectPermission = architect.permission as Record<string, string>
      const architectAutoPermission = architectAuto.permission as Record<string, string>

      for (const tool of ['apply_patch', 'edit', 'write', 'multiedit', 'patch', 'task', 'plan', 'plan_enter', 'plan_exit']) {
        expect(architectTools[tool]).toBe(false)
        expect(architectAutoTools[tool]).toBe(false)
        expect(architectPermission[tool]).toBe('deny')
        expect(architectAutoPermission[tool]).toBe('deny')
      }

      expect(architectTools.bash).toBeUndefined()
      expect(architectAutoTools.bash).toBeUndefined()
      expect(architectPermission.bash).toBeUndefined()
      expect(architectAutoPermission.bash).toBeUndefined()

      expect(architectPermission.question).toBe('allow')
      expect(architectTools.question).toBeUndefined()
      expect(architectAutoPermission.question).toBe('deny')
      expect(architectAutoTools.question).toBe(false)

      for (const tool of ['execute-plan', 'execute-goal', 'launch-group', 'group-status', 'group-cancel', 'loop-status', 'loop-cancel']) {
        expect(architectTools[tool]).toBeUndefined()
        expect(architectPermission[tool]).toBeUndefined()
        expect(architectAutoTools[tool]).toBe(false)
        expect(architectAutoPermission[tool]).toBe('deny')
      }

      for (const tool of ['plan-read', 'plan-write', 'plan-edit']) {
        expect(architectTools[tool]).toBeUndefined()
        expect(architectAutoTools[tool]).toBeUndefined()
        expect(architectPermission[tool]).toBeUndefined()
        expect(architectAutoPermission[tool]).toBeUndefined()
      }
    })

    test('leaves global permission config untouched', async () => {
      const configHandler = createConfigHandler(agents)
      const untouched: Record<string, unknown> = {}
      const withUserSettings: Record<string, unknown> = {
        permission: {
          bash: 'ask',
        },
      }

      await configHandler(untouched)
      await configHandler(withUserSettings)

      expect(untouched.permission).toBeUndefined()
      expect(withUserSettings.permission).toEqual({ bash: 'ask' })
    })

    test('code agent excluded tools are mirrored to permission: deny (opencode enforces via permission, not tools)', async () => {
      const configHandler = createConfigHandler(agents)
      const config: Record<string, unknown> = {}

      await configHandler(config)

      const agentConfigs = config.agent as Record<string, unknown>
      const code = agentConfigs.code as Record<string, unknown>
      const permission = code.permission as Record<string, string>

      expect(permission).toBeDefined()
      for (const tool of ['review-write', 'review-delete', 'plan', 'plan_enter', 'plan_exit', 'plan-write', 'plan-edit']) {
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

      for (const tool of ['review-write', 'review-delete', 'plan', 'plan_enter', 'plan_exit', 'plan-write', 'plan-edit']) {
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
