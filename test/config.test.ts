import { describe, test, expect } from 'bun:test'
import { createConfigHandler } from '../src/config'
import { agents } from '../src/agents'

describe('createConfigHandler', () => {
  describe('built-in explore agent enhancement', () => {
    test('explore agent receives three graph tool permissions', async () => {
      const configHandler = createConfigHandler(agents)
      const config: Record<string, unknown> = {}

      await configHandler(config)

      const exploreConfig = config.agent as Record<string, unknown>
      const explore = exploreConfig?.explore as Record<string, unknown>

      expect(explore).toBeDefined()
      expect(explore.permission).toBeDefined()

      const permission = explore.permission as Record<string, string>
      expect(permission['graph-query']).toBe('allow')
      expect(permission['graph-symbols']).toBe('allow')
      expect(permission['graph-analyze']).toBe('allow')
    })

    test('explore agent receives graph-first prompt suffix', async () => {
      const configHandler = createConfigHandler(agents)
      const config: Record<string, unknown> = {}
      
      await configHandler(config)
      
      const exploreConfig = config.agent as Record<string, unknown>
      const explore = exploreConfig?.explore as Record<string, unknown>
      
      expect(explore).toBeDefined()
      expect(explore.prompt).toBeDefined()
      
      const prompt = explore.prompt as string
      expect(prompt).toContain('graph-query')
      expect(prompt).toContain('graph-symbols')
      expect(prompt).toContain('graph-analyze')
      expect(prompt).toContain('Graph-first discovery hierarchy')
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
      expect(prompt).toMatch(/graph-first|Graph-first/i)
    })

    test('explore prompt includes fallback guidance for Glob/Grep', async () => {
      const configHandler = createConfigHandler(agents)
      const config: Record<string, unknown> = {}
      
      await configHandler(config)
      
      const exploreConfig = config.agent as Record<string, unknown>
      const explore = exploreConfig?.explore as Record<string, unknown>
      
      const prompt = explore.prompt as string
      expect(prompt).toMatch(/fallback.*glob.*grep|glob.*grep.*fallback/i)
    })

    test('explore prompt includes Read as direct inspection step', async () => {
      const configHandler = createConfigHandler(agents)
      const config: Record<string, unknown> = {}
      
      await configHandler(config)
      
      const exploreConfig = config.agent as Record<string, unknown>
      const explore = exploreConfig?.explore as Record<string, unknown>
      
      const prompt = explore.prompt as string
      expect(prompt).toMatch(/read.*inspect|direct.*inspection/i)
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
      expect(explore.prompt).toMatch(/graph-first|Graph-first/i)
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
      expect(permission['graph-query']).toBe('allow')
      expect(permission['graph-symbols']).toBe('allow')
      expect(permission['graph-analyze']).toBe('allow')
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

    test('explicit user override can override built-in tool denies', async () => {
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
      
      expect(tools['review-delete']).toBe(true)
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
