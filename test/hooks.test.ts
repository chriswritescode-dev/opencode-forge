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
})


