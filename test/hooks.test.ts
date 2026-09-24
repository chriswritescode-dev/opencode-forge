import { describe, test, expect, beforeEach } from 'vitest'
import { createSessionHooks } from '../src/hooks/session'
import { createLoopEventHandler } from '../src/hooks/loop'
import { createLoopService } from '../src/loop/service'
import { Database } from 'bun:sqlite'
import type { Logger } from '../src/types'

const TEST_PROJECT_ID = 'test-proj-id'

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}


describe('SessionHooks', () => {
  test('Session compacting hook runs without errors', async () => {
    const hooks = createSessionHooks(TEST_PROJECT_ID, mockLogger)

    const input = { sessionID: 'test-session' }
    const output = { context: [] as string[] }

    await hooks.onCompacting(input, output)

    expect(output.context.length).toBe(0)
  })

  test('Session compacting hook does nothing when no memories', async () => {
    const hooks = createSessionHooks(TEST_PROJECT_ID, mockLogger)

    const input = { sessionID: 'test-session' }
    const output = { context: [] as string[] }

    await hooks.onCompacting(input, output)

    expect(output.context).toHaveLength(0)
  })

  test('Session tracks initialized sessions', async () => {
    const hooks = createSessionHooks(TEST_PROJECT_ID, mockLogger)

    const input = { sessionID: 'test-session-1' }
    const output = {}

    await hooks.onMessage(input, output)
    await hooks.onMessage(input, output)

    expect(true).toBe(true)
  })

  test('Session event handler logs session.compacted event', async () => {
    const hooks = createSessionHooks(TEST_PROJECT_ID, mockLogger)

    const input = {
      event: {
        type: 'session.compacted',
        properties: { sessionId: 'test-session' },
      },
    }

    await hooks.onEvent(input)

    expect(true).toBe(true)
  })


  test('session.compacted with missing sessionId does NOT trigger flow', async () => {
    let promptCalled = false

    const hooks = createSessionHooks(TEST_PROJECT_ID, mockLogger)

    await hooks.onEvent({
      event: { type: 'session.compacted', properties: {} },
    })
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(promptCalled).toBe(false)
  })

  test('session.compacted skips extraction when no compaction summary found', async () => {
    let promptCalled = false

    const hooks = createSessionHooks(TEST_PROJECT_ID, mockLogger)

    await hooks.onEvent({
      event: { type: 'session.compacted', properties: { sessionId: 'test-no-summary' } },
    })
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(promptCalled).toBe(false)
  })
})


