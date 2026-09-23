import { describe, test, expect } from 'vitest'
import { createTools } from '../../src/tools'
import { registerForgeToolsV2 } from '../../src/host/v2-tools'
import { createFakeV2Context, type RecordedTool } from '../helpers/fake-v2-context'
import type { ToolContext } from '../../src/tools/types'

const PLAN = '# Plan\n\nLine A\nLine B'

function stubContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    projectId: 'proj_v2',
    directory: '/tmp/forge-v2-tools',
    config: {} as never,
    logger: { log() {}, error() {}, debug() {} },
    db: {} as never,
    dataDir: '/tmp',
    loopHandler: {} as never,
    loop: { service: { resolveLoopName: () => null } } as never,
    client: {} as never,
    cleanup: async () => {},
    sandboxManager: null,
    plansRepo: { getForSession: () => ({ content: PLAN }) } as never,
    reviewFindingsRepo: {} as never,
    loopsRepo: {} as never,
    sectionPlansRepo: {} as never,
    featureGroupsRepo: {} as never,
    groupOrchestrator: {} as never,
    workspaceStatusRegistry: {} as never,
    pendingTeardowns: {} as never,
    resolveActiveLoopForSession: async () => null,
    ...overrides,
  }
}

function callContext(sessionID: string) {
  return {
    sessionID,
    messageID: 'msg_v2',
    agent: 'code',
    id: 'call_v2',
    signal: new AbortController().signal,
    progress: async () => {},
  }
}

async function registerTools(context: ToolContext): Promise<RecordedTool[]> {
  const { ctx, tools } = createFakeV2Context()
  await registerForgeToolsV2(ctx, createTools(context))
  return tools
}

describe('registerForgeToolsV2', () => {
  test('registers every Forge tool with its V1 name, description, and direct options', async () => {
    const forgeTools = createTools(stubContext())
    const registered = await registerTools(stubContext())

    expect(registered.map((tool) => tool.name)).toEqual(Object.keys(forgeTools))
    for (const tool of registered) {
      expect(tool.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
      expect(tool.description).toBe(forgeTools[tool.name].description)
      expect(tool.options).toEqual({ codemode: false })
      expect(tool.input).toMatchObject({ type: 'object' })
    }
  })

  test('advertises defaulted arguments as optional and drops the JSON Schema dialect', async () => {
    const registered = await registerTools(stubContext())
    const executePlan = registered.find((tool) => tool.name === 'execute-plan')!
    const input = executePlan.input as {
      $schema?: unknown
      required?: string[]
      properties: Record<string, { default?: unknown }>
    }

    expect(input.$schema).toBeUndefined()
    expect(input.required).toEqual(['title'])
    expect(input.properties.mode).toMatchObject({ default: 'loop' })
  })

  test('plan-read executes through the V2 tool context and returns content only', async () => {
    const registered = await registerTools(stubContext())
    const planRead = registered.find((tool) => tool.name === 'plan-read')!
    const result = (await planRead.execute({}, callContext('ses_v2'))) as Record<string, unknown>

    expect(Object.keys(result)).toEqual(['content'])
    expect(result.content).toContain('1: # Plan')
  })

  test('invalid input rejects with the zod issues', async () => {
    const registered = await registerTools(stubContext())
    const planRead = registered.find((tool) => tool.name === 'plan-read')!

    await expect(planRead.execute({ offset: 'nope' }, callContext('ses_v2'))).rejects.toThrow(/offset/)
  })
})
