import { describe, test, expect, vi } from 'vitest'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { fetchLatestPlanForSession } from '../../src/utils/plan-from-messages'
import { PLAN_START_MARKER, PLAN_END_MARKER } from '../../src/utils/marked-plan-parser'

type MessagesFn = OpencodeClient['session']['messages']

function makeClient(messagesFn: ReturnType<typeof vi.fn>): OpencodeClient {
  return {
    session: {
      messages: messagesFn as unknown as MessagesFn,
    },
  } as unknown as OpencodeClient
}

function assistantMessage(text: string, id = 'msg-1'): { info: { role: string; id: string }; parts: Array<{ type: string; text: string }> } {
  return {
    info: { role: 'assistant', id },
    parts: [{ type: 'text', text }],
  }
}

const VALID_PLAN = [
  PLAN_START_MARKER,
  '# Implementation Plan',
  '',
  '## Phase 1',
  'Do stuff.',
  PLAN_END_MARKER,
].join('\n')

const VALID_PLAN_TEXT = '# Implementation Plan\n\n## Phase 1\nDo stuff.'

describe('fetchLatestPlanForSession', () => {
  test('returns the marked plan text when present in the latest assistant message', async () => {
    const messages = vi.fn(async () => ({ data: [assistantMessage(`Some preamble\n${VALID_PLAN}\nSome closing words`)] }))
    const client = makeClient(messages)
    const result = await fetchLatestPlanForSession(client, 'sess-1', '/tmp/proj')
    expect(result).toBe(VALID_PLAN_TEXT)
    expect(messages).toHaveBeenCalledWith({
      sessionID: 'sess-1',
      directory: '/tmp/proj',
      limit: 20,
    })
  })

  test('omits `directory` from the SDK call when not provided', async () => {
    const messages = vi.fn(async () => ({ data: [assistantMessage(VALID_PLAN)] }))
    const client = makeClient(messages)
    await fetchLatestPlanForSession(client, 'sess-1', undefined)
    expect(messages).toHaveBeenCalledWith({ sessionID: 'sess-1', limit: 20 })
  })

  test('honors a custom limit', async () => {
    const messages = vi.fn(async () => ({ data: [assistantMessage(VALID_PLAN)] }))
    const client = makeClient(messages)
    await fetchLatestPlanForSession(client, 'sess-1', '/tmp/proj', { limit: 5 })
    expect(messages).toHaveBeenCalledWith({ sessionID: 'sess-1', directory: '/tmp/proj', limit: 5 })
  })

  test('picks the most recent marked plan when multiple assistant messages exist', async () => {
    const older = `${PLAN_START_MARKER}\nold plan\n${PLAN_END_MARKER}`
    const newer = `${PLAN_START_MARKER}\nnew plan\n${PLAN_END_MARKER}`
    const messages = vi.fn(async () => ({
      data: [
        assistantMessage(older, 'msg-old'),
        assistantMessage('some interleaving chat', 'msg-chat'),
        assistantMessage(newer, 'msg-new'),
      ],
    }))
    const client = makeClient(messages)
    const result = await fetchLatestPlanForSession(client, 'sess-1', '/tmp/proj')
    expect(result).toBe('new plan')
  })

  test('returns null and logs when the messages call errors', async () => {
    const messages = vi.fn(async () => ({ error: new Error('boom') }))
    const client = makeClient(messages)
    const debug = vi.fn(() => {})
    const result = await fetchLatestPlanForSession(client, 'sess-1', '/tmp/proj', { debug })
    expect(result).toBeNull()
    expect(debug).toHaveBeenCalled()
  })

  test('returns null and logs when the messages call throws', async () => {
    const messages = vi.fn(async () => { throw new Error('network') })
    const client = makeClient(messages)
    const debug = vi.fn(() => {})
    const result = await fetchLatestPlanForSession(client, 'sess-1', '/tmp/proj', { debug })
    expect(result).toBeNull()
    expect(debug).toHaveBeenCalled()
  })

  test('returns null when the session has no messages', async () => {
    const messages = vi.fn(async () => ({ data: [] }))
    const client = makeClient(messages)
    const debug = vi.fn(() => {})
    const result = await fetchLatestPlanForSession(client, 'sess-1', '/tmp/proj', { debug })
    expect(result).toBeNull()
    expect(debug).toHaveBeenCalled()
  })

  test('returns null when no assistant message contains plan markers', async () => {
    const messages = vi.fn(async () => ({
      data: [assistantMessage('Just chatting, no plan in here.', 'msg-1')],
    }))
    const client = makeClient(messages)
    const result = await fetchLatestPlanForSession(client, 'sess-1', '/tmp/proj')
    expect(result).toBeNull()
  })

  test('returns null when the latest plan is unterminated (start without end)', async () => {
    const messages = vi.fn(async () => ({
      data: [assistantMessage(`${PLAN_START_MARKER}\noops no end marker`, 'msg-1')],
    }))
    const client = makeClient(messages)
    const debug = vi.fn(() => {})
    const result = await fetchLatestPlanForSession(client, 'sess-1', '/tmp/proj', { debug })
    expect(result).toBeNull()
    expect(debug).toHaveBeenCalled()
  })

  test('returns null when the latest plan is empty between markers', async () => {
    const messages = vi.fn(async () => ({
      data: [assistantMessage(`${PLAN_START_MARKER}\n\n${PLAN_END_MARKER}`, 'msg-1')],
    }))
    const client = makeClient(messages)
    const result = await fetchLatestPlanForSession(client, 'sess-1', '/tmp/proj')
    expect(result).toBeNull()
  })

  test('skips user messages when scanning for the latest plan', async () => {
    const messages = vi.fn(async () => ({
      data: [
        assistantMessage(VALID_PLAN, 'msg-old'),
        { info: { role: 'user', id: 'msg-user' }, parts: [{ type: 'text', text: 'noise' }] },
      ],
    }))
    const client = makeClient(messages)
    const result = await fetchLatestPlanForSession(client, 'sess-1', '/tmp/proj')
    expect(result).toBe(VALID_PLAN_TEXT)
  })

  test('debug callback receives a string for the success path', async () => {
    const messages = vi.fn(async () => ({ data: [assistantMessage(VALID_PLAN, 'msg-123')] }))
    const client = makeClient(messages)
    const debug = vi.fn((..._args: unknown[]) => {})
    await fetchLatestPlanForSession(client, 'sess-1', '/tmp/proj', { debug })
    expect(debug).toHaveBeenCalled()
    const args = debug.mock.calls[0]
    expect(typeof args[0]).toBe('string')
  })
})
