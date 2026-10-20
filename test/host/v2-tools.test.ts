import { describe, test, expect, afterEach } from 'vitest'
import { createTools } from '../../src/tools'
import { registerForgeToolsV2 } from '../../src/host/v2-tools'
import { createFakeV2Context, type FakeV2Context, type RecordedTool } from '../helpers/fake-v2-context'
import type { ToolContext } from '../../src/tools/types'

const PLAN = '# Plan\n\nLine A\nLine B'
const PLAN_A = '# Plan A\n\nproject A content'
const PLAN_B = '# Plan B\n\nproject B content'

const unregisters: Array<() => void> = []

afterEach(() => {
  for (const unregister of unregisters.splice(0)) unregister()
})

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

async function register(
  fake: FakeV2Context,
  context: ToolContext,
): Promise<RecordedTool[]> {
  unregisters.push(await registerForgeToolsV2(fake.ctx, createTools(context)))
  return fake.tools
}

async function registerTools(context: ToolContext): Promise<RecordedTool[]> {
  return register(createFakeV2Context({ location: { directory: context.directory } }), context)
}

function planRead(tools: RecordedTool[]): RecordedTool {
  return tools.find((tool) => tool.name === 'plan-read')!
}

function sessionAt(directory: string) {
  return async (input?: { sessionID?: string }) => ({
    id: input?.sessionID ?? 'ses_v2',
    projectID: 'proj_fake',
    location: { directory },
    time: { created: 1, updated: 1 },
  })
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
    const result = (await planRead(registered).execute({}, callContext('ses_v2'))) as Record<string, unknown>

    expect(Object.keys(result)).toEqual(['content'])
    expect(result.content).toContain('1: # Plan')
  })

  test('invalid input rejects with the zod issues', async () => {
    const registered = await registerTools(stubContext())

    await expect(planRead(registered).execute({ offset: 'nope' }, callContext('ses_v2'))).rejects.toThrow(/offset/)
  })

  test('routes a call to the instance registered for the calling session location', async () => {
    const a = createFakeV2Context({ location: { directory: '/project-a' } })
    const b = createFakeV2Context({ location: { directory: '/project-b' }, session: { get: sessionAt('/project-a') } })

    await register(a, stubContext({
      directory: '/project-a',
      plansRepo: { getForSession: () => ({ content: PLAN_A }) } as never,
    }))
    const registeredB = await register(b, stubContext({
      directory: '/project-b',
      plansRepo: { getForSession: () => ({ content: PLAN_B }) } as never,
    }))

    const result = (await planRead(registeredB).execute({}, callContext('ses_a'))) as Record<string, unknown>
    expect(result.content).toContain('project A content')
    expect(result.content).not.toContain('project B content')
  })

  test('a failed registration at an already registered location keeps the earlier registration', async () => {
    const a = createFakeV2Context({ location: { directory: '/project-a' }, session: { get: sessionAt('/project-a') } })
    await register(a, stubContext({
      directory: '/project-a',
      plansRepo: { getForSession: () => ({ content: PLAN_A }) } as never,
    }))

    const failing = createFakeV2Context({
      location: { directory: '/project-a' },
      tool: { transform: async () => { throw new Error('transform failed') } },
    })

    await expect(registerForgeToolsV2(failing.ctx, createTools(stubContext({ directory: '/project-a' }))))
      .rejects.toThrow('transform failed')

    const result = (await planRead(a.tools).execute({}, callContext('ses_a'))) as Record<string, unknown>
    expect(result.content).toContain('project A content')
  })

  test('rejects a session located in a directory with no registered instance', async () => {
    const fake = createFakeV2Context({
      location: { directory: '/project-b' },
      session: { get: sessionAt('/project-nowhere') },
    })
    const registered = await register(fake, stubContext({ directory: '/project-b' }))

    await expect(planRead(registered).execute({}, callContext('ses_foreign')))
      .rejects.toThrow('Forge is not loaded for this session\'s location (/project-nowhere); retry once it has started.')
  })

  test('rejects with a clear error when the session lookup fails', async () => {
    const fake = createFakeV2Context({
      location: { directory: '/project-b' },
      session: { get: async () => { throw new Error('session lookup failed') } },
    })
    const registered = await register(fake, stubContext({ directory: '/project-b' }))

    await expect(planRead(registered).execute({}, callContext('ses_missing')))
      .rejects.toThrow(/could not resolve the location of session ses_missing/)
  })

  test('unregistering a location rejects its sessions and leaves a newer registration intact', async () => {
    const fake = createFakeV2Context({ location: { directory: '/project-a' }, session: { get: sessionAt('/project-a') } })

    const unregisterOld = await registerForgeToolsV2(fake.ctx, createTools(stubContext({
      directory: '/project-a',
      plansRepo: { getForSession: () => ({ content: PLAN_A }) } as never,
    })))
    unregisterOld()

    await expect(planRead(fake.tools).execute({}, callContext('ses_a')))
      .rejects.toThrow(/Forge is not loaded for this session's location \(\/project-a\)/)

    fake.tools.length = 0
    const unregisterNew = await registerForgeToolsV2(fake.ctx, createTools(stubContext({
      directory: '/project-a',
      plansRepo: { getForSession: () => ({ content: PLAN_B }) } as never,
    })))
    unregisters.push(unregisterNew)

    unregisterOld()
    const result = (await planRead(fake.tools).execute({}, callContext('ses_a'))) as Record<string, unknown>
    expect(result.content).toContain('project B content')

    unregisterNew()
    await expect(planRead(fake.tools).execute({}, callContext('ses_a')))
      .rejects.toThrow(/Forge is not loaded for this session's location \(\/project-a\)/)
  })
})
