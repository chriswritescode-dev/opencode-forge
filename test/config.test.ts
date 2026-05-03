import { describe, test, expect } from 'bun:test'
import { createConfigHandler } from '../src/config'
import { agents } from '../src/agents'

describe('createConfigHandler', () => {
  describe('built-in explore agent enhancement', () => {
    test('explore enhancement contains fallow discovery rule and no graph-tool names', async () => {
      const configHandler = createConfigHandler(agents)
      const config: Record<string, unknown> = {}

      await configHandler(config)

      const exploreConfig = config.agent as Record<string, unknown>
      const explore = exploreConfig?.explore as Record<string, unknown>

      expect(explore).toBeDefined()
      const prompt = explore.prompt as string
      expect(prompt).toContain('fallow')
      expect(prompt).not.toContain('graph-query')
      expect(prompt).not.toContain('graph-symbols')
      expect(prompt).not.toContain('graph-analyze')
    })

    test('explore prompt does not include architect-specific plan workflow text', async () => {
      const configHandler = createConfigHandler(agents)
      const config: Record<string, unknown> = {}
      
      await configHandler(config)
      
      const exploreConfig = config.agent as Record<string, unknown>
      const explore = exploreConfig?.explore as Record<string, unknown>
      
      const prompt = explore.prompt as string
      expect(prompt).not.toContain('plan-write')
      expect(prompt).not.toContain('plan-edit')
      expect(prompt).not.toContain('plan-read')
      expect(prompt).not.toContain('READ-ONLY mode')
    })

    test('explore prompt augmentation is appended not replaced', async () => {
      const configHandler = createConfigHandler(agents)
      
      const config: Record<string, unknown> = {
        agent: {
          explore: {
            prompt: 'Custom explore prompt prefix',
          },
        },
      }
      
      await configHandler(config)
      
      const exploreConfig = config.agent as Record<string, unknown>
      const explore = exploreConfig?.explore as Record<string, unknown>
      
      const prompt = explore.prompt as string
      expect(prompt).toContain('Custom explore prompt prefix')
      expect(prompt).toContain('fallow')
    })

    test('explore prompt includes fallback guidance for Glob/Grep', async () => {
      const configHandler = createConfigHandler(agents)
      const config: Record<string, unknown> = {}
      
      await configHandler(config)
      
      const exploreConfig = config.agent as Record<string, unknown>
      const explore = exploreConfig?.explore as Record<string, unknown>
      
      const prompt = explore.prompt as string
      // FALLOW_RULES mentions using fallow-dead-code with files: [...] for targeted file inspection
      expect(prompt).toMatch(/fallow-dead-code.*files|Use Read or Grep/i)
    })

    test('explore prompt includes Read as direct inspection step', async () => {
      const configHandler = createConfigHandler(agents)
      const config: Record<string, unknown> = {}
      
      await configHandler(config)
      
      const exploreConfig = config.agent as Record<string, unknown>
      const explore = exploreConfig?.explore as Record<string, unknown>
      
      const prompt = explore.prompt as string
      // FALLOW_RULES mentions "Use Read or Grep on that path to drill in"
      expect(prompt).toMatch(/Use Read or Grep/i)
    })
  })

  describe('config merge behavior', () => {
    test('existing built-in agent prompts are preserved and augmented', async () => {
      const configHandler = createConfigHandler(agents)
      
      const config: Record<string, unknown> = {
        agent: {
          explore: {
            prompt: 'Original explore prompt',
            temperature: 0.5,
          },
        },
      }
      
      await configHandler(config)
      
      const exploreConfig = config.agent as Record<string, unknown>
      const explore = exploreConfig?.explore as Record<string, unknown>
      
      expect(explore.prompt).toContain('Original explore prompt')
      expect(explore.prompt).toContain('fallow')
      expect(explore.temperature).toBe(0.5)
    })

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
      
      expect(agentConfigs.explore).toBeDefined()
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

    test('code agent excluded tools are mirrored to permission: deny (opencode enforces via permission, not tools)', async () => {
      const configHandler = createConfigHandler(agents)
      const config: Record<string, unknown> = {}

      await configHandler(config)

      const agentConfigs = config.agent as Record<string, unknown>
      const code = agentConfigs.code as Record<string, unknown>
      const permission = code.permission as Record<string, string>

      expect(permission).toBeDefined()
      for (const tool of ['review-write', 'review-delete', 'plan-execute', 'loop']) {
        expect(permission[tool]).toBe('deny')
      }
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
      // Other excludes should still be denied.
      expect(permission['plan-execute']).toBe('deny')
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
  })
})
