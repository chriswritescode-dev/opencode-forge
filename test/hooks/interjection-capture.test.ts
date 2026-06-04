import { describe, test, expect, vi } from 'vitest'
import { createInterjectionCaptureHook } from '../../src/hooks/interjection-capture'

describe('createInterjectionCaptureHook', () => {
  function buildDeps(overrides?: {
    recordUserMessage?: ReturnType<typeof vi.fn>
    loggerLog?: ReturnType<typeof vi.fn>
    loggerError?: ReturnType<typeof vi.fn>
  }) {
    const recordUserMessage = overrides?.recordUserMessage ?? vi.fn().mockReturnValue(true)
    const loggerLog = overrides?.loggerLog ?? vi.fn()
    const loggerError = overrides?.loggerError ?? vi.fn()
    return {
      recordUserMessage,
      logger: { log: loggerLog, error: loggerError, debug: vi.fn() },
    }
  }

  test('extracts text from output parts and forwards to recordUserMessage', async () => {
    const recordUserMessage = vi.fn().mockReturnValue(true)
    const loggerLog = vi.fn()
    const hook = createInterjectionCaptureHook(buildDeps({ recordUserMessage, loggerLog }))

    await hook(
      { sessionID: 'sess_123' },
      { parts: [{ type: 'text', text: 'use approach X instead' }] },
    )

    expect(recordUserMessage).toHaveBeenCalledTimes(1)
    expect(recordUserMessage).toHaveBeenCalledWith('sess_123', 'use approach X instead')
    expect(loggerLog).toHaveBeenCalledWith('Loop: user interjection captured session=sess_123')
  })

  test('concatenates multiple text parts into one message', async () => {
    const recordUserMessage = vi.fn().mockReturnValue(true)
    const hook = createInterjectionCaptureHook(buildDeps({ recordUserMessage }))

    await hook(
      { sessionID: 'sess_123' },
      {
        parts: [
          { type: 'text', text: 'first line' },
          { type: 'tool_result', text: 'ignored' },
          { type: 'text', text: 'second line' },
        ],
      },
    )

    expect(recordUserMessage).toHaveBeenCalledWith('sess_123', 'first line\nsecond line')
  })

  test('does not call recordUserMessage when output has no text parts', async () => {
    const recordUserMessage = vi.fn()
    const hook = createInterjectionCaptureHook(buildDeps({ recordUserMessage }))

    await hook(
      { sessionID: 'sess_123' },
      { parts: [{ type: 'tool_result', text: 'some result' }] },
    )

    expect(recordUserMessage).not.toHaveBeenCalled()
  })

  test('does not call recordUserMessage when output parts are empty', async () => {
    const recordUserMessage = vi.fn()
    const hook = createInterjectionCaptureHook(buildDeps({ recordUserMessage }))

    await hook(
      { sessionID: 'sess_123' },
      { parts: [] },
    )

    expect(recordUserMessage).not.toHaveBeenCalled()
  })

  test('does not call recordUserMessage when output parts are undefined', async () => {
    const recordUserMessage = vi.fn()
    const hook = createInterjectionCaptureHook(buildDeps({ recordUserMessage }))

    await hook(
      { sessionID: 'sess_123' },
      {},
    )

    expect(recordUserMessage).not.toHaveBeenCalled()
  })

  test('does not call recordUserMessage when sessionID is missing', async () => {
    const recordUserMessage = vi.fn()
    const hook = createInterjectionCaptureHook(buildDeps({ recordUserMessage }))

    await hook(
      {},
      { parts: [{ type: 'text', text: 'hello' }] },
    )

    expect(recordUserMessage).not.toHaveBeenCalled()
  })

  test('does not call recordUserMessage when sessionID is undefined', async () => {
    const recordUserMessage = vi.fn()
    const hook = createInterjectionCaptureHook(buildDeps({ recordUserMessage }))

    await hook(
      { sessionID: undefined },
      { parts: [{ type: 'text', text: 'hello' }] },
    )

    expect(recordUserMessage).not.toHaveBeenCalled()
  })

  test('handles null/undefined input gracefully', async () => {
    const recordUserMessage = vi.fn()
    const hook = createInterjectionCaptureHook(buildDeps({ recordUserMessage }))

    await hook(undefined as any, { parts: [{ type: 'text', text: 'hello' }] })

    expect(recordUserMessage).not.toHaveBeenCalled()
  })

  test('swallows a throwing recordUserMessage and logs error', async () => {
    const err = new Error('storage failure')
    const recordUserMessage = vi.fn().mockImplementation(() => { throw err })
    const loggerError = vi.fn()
    const hook = createInterjectionCaptureHook(buildDeps({ recordUserMessage, loggerError }))

    // Should not throw
    await expect(
      hook(
        { sessionID: 'sess_123' },
        { parts: [{ type: 'text', text: 'hello' }] },
      ),
    ).resolves.toBeUndefined()

    expect(loggerError).toHaveBeenCalledWith('Loop: interjection capture failed', err)
  })

  test('does not log when recordUserMessage returns false', async () => {
    const recordUserMessage = vi.fn().mockReturnValue(false)
    const loggerLog = vi.fn()
    const hook = createInterjectionCaptureHook(buildDeps({ recordUserMessage, loggerLog }))

    await hook(
      { sessionID: 'sess_123' },
      { parts: [{ type: 'text', text: 'hello' }] },
    )

    expect(recordUserMessage).toHaveBeenCalledWith('sess_123', 'hello')
    expect(loggerLog).not.toHaveBeenCalled()
  })
})
