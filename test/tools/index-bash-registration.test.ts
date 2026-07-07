import { describe, test, expect } from 'vitest'
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
    client: {} as never,
    cleanup: async () => {},
    sandboxManager: null,
    plansRepo: {} as never,
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

describe('createTools shell tool registration', () => {
  test('never registers sh and never overrides bash, regardless of sandboxManager', () => {
    for (const sandboxManager of [null, {} as never]) {
      const tools = createTools(baseCtx({ sandboxManager }))
      expect(tools.sh).toBeUndefined()
      expect(tools.bash).toBeUndefined()
    }
  })
})
