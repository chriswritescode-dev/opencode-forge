import { describe, test, expect } from 'bun:test'
import { createTools } from '../../src/tools'
import type { ToolContext } from '../../src/tools/types'

function baseCtx(overrides: Partial<ToolContext>): ToolContext {
  return {
    projectId: 'p',
    directory: '/tmp',
    config: {} as never,
    logger: { log() {}, error() {}, debug() {} },
    db: {} as never,
    dataDir: '/tmp',
    loopHandler: {} as never,
    loop: {} as never,
    v2: {} as never,
    cleanup: async () => {},
    input: {} as never,
    sandboxManager: null,
    plansRepo: {} as never,
    reviewFindingsRepo: {} as never,
    loopsRepo: {} as never,
    sectionPlansRepo: {} as never,
    workspaceStatusRegistry: {} as never,
    pendingTeardowns: {} as never,
    resolveSandboxForSession: async () => null,
    ...overrides,
  }
}

describe('createTools bash registration', () => {
  test('does not register bash when sandboxManager is null', () => {
    const tools = createTools(baseCtx({ sandboxManager: null }))
    expect(tools.bash).toBeUndefined()
  })

  test('registers bash when sandboxManager is non-null', () => {
    const tools = createTools(baseCtx({ sandboxManager: {} as never }))
    expect(tools.bash).toBeDefined()
    expect(typeof tools.bash.execute).toBe('function')
  })
})
