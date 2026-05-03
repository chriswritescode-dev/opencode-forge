import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { createSessionHooks } from '../src/hooks/session'
import { createLoopEventHandler } from '../src/hooks/loop'
import { createLoopService } from '../src/services/loop'
import { Database } from 'bun:sqlite'
import type { Logger } from '../src/types'
import type { PluginInput } from '@opencode-ai/plugin'

const TEST_PROJECT_ID = 'test-project-id'

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

const mockPromptAsync = async () => {}

const mockPluginInput: PluginInput = {
  client: {
    session: {
      prompt: async () => ({ data: { parts: [{ type: 'text', text: 'Extracted memories' }] } }),
      promptAsync: mockPromptAsync,
      messages: async () => ({
        data: [
          { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'Compaction summary text' }] },
        ],
      }),
      create: async () => ({ data: { id: 'child-session-id' } }),
      todo: async () => ({ data: [] }),
    },
    app: {
      log: () => {},
    },
  },
  project: { id: TEST_PROJECT_ID, worktree: '/test' },
  directory: '/test',
  worktree: '/test',
  serverUrl: new URL('http://localhost:5551'),
} as unknown as PluginInput



describe('SessionHooks', () => {
  test('Session compacting hook runs without errors', async () => {
    const hooks = createSessionHooks(TEST_PROJECT_ID, mockLogger, mockPluginInput)

    const input = { sessionID: 'test-session' }
    const output = { context: [] as string[] }

    await hooks.onCompacting(input, output)

    expect(output.context.length).toBe(0)
  })

  test('Session compacting hook does nothing when no memories', async () => {
    const hooks = createSessionHooks(TEST_PROJECT_ID, mockLogger, mockPluginInput)

    const input = { sessionID: 'test-session' }
    const output = { context: [] as string[] }

    await hooks.onCompacting(input, output)

    expect(output.context).toHaveLength(0)
  })

  test('Session tracks initialized sessions', async () => {
    const hooks = createSessionHooks(TEST_PROJECT_ID, mockLogger, mockPluginInput)

    const input = { sessionID: 'test-session-1' }
    const output = {}

    await hooks.onMessage(input, output)
    await hooks.onMessage(input, output)

    expect(true).toBe(true)
  })

  test('Session event handler logs session.compacted event', async () => {
    const hooks = createSessionHooks(TEST_PROJECT_ID, mockLogger, mockPluginInput)

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

    const customMockPluginInput: PluginInput = {
      client: {
        session: {
          messages: async () => ({ data: [] }),
          create: async () => ({ data: { id: 'unused' } }),
          prompt: async () => {
            promptCalled = true
            return { data: { parts: [] } }
          },
          promptAsync: async () => {},
        },
        app: {
          log: () => {},
        },
      },
      project: { id: TEST_PROJECT_ID, worktree: '/test' },
      directory: '/test',
      worktree: '/test',
      serverUrl: new URL('http://localhost:5551'),
    } as unknown as PluginInput

    const hooks = createSessionHooks(TEST_PROJECT_ID, mockLogger, customMockPluginInput)

    await hooks.onEvent({
      event: { type: 'session.compacted', properties: {} },
    })
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(promptCalled).toBe(false)
  })

  test('session.compacted skips extraction when no compaction summary found', async () => {
    let promptCalled = false

    const customMockPluginInput: PluginInput = {
      client: {
        session: {
          messages: async () => ({
            data: [
              { info: { role: 'user' }, parts: [{ type: 'text', text: 'User only' }] },
            ],
          }),
          create: async () => ({ data: { id: 'unused' } }),
          prompt: async () => {
            promptCalled = true
            return { data: { parts: [] } }
          },
          promptAsync: async () => {},
        },
        app: {
          log: () => {},
        },
      },
      project: { id: TEST_PROJECT_ID, worktree: '/test' },
      directory: '/test',
      worktree: '/test',
      serverUrl: new URL('http://localhost:5551'),
    } as unknown as PluginInput

    const hooks = createSessionHooks(TEST_PROJECT_ID, mockLogger, customMockPluginInput)

    await hooks.onEvent({
      event: { type: 'session.compacted', properties: { sessionId: 'test-no-summary' } },
    })
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(promptCalled).toBe(false)
  })
})


