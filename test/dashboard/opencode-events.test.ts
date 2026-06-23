import { describe, test, expect, vi } from 'vitest'
import {
  forwardOpencodeEvents,
  forwardGlobalEvents,
  startActivityForwarding,
} from '../../src/dashboard/opencode-events'
import type { OpencodeActivityEvent } from '../../src/observability/types'
import { ForgeClientError, type ForgeClient, type GlobalActivityEvent } from '../../src/client/port'

describe('forwardOpencodeEvents', () => {
  // ─── subscribes to all four curated event types ───────────────────────

  test('subscribes to all curated session and transcript-part event types', () => {
    const subscribedTypes: string[] = []
    const bus = {
      on(type: string, _handler: (event: any) => void) {
        subscribedTypes.push(type)
        return () => {}
      },
    }

    forwardOpencodeEvents(bus, () => {})

    expect(subscribedTypes).toEqual([
      'session.idle',
      'session.status',
      'session.created',
      'session.updated',
      'session.error',
      'session.deleted',
      'message.updated',
      'message.part.updated',
      'message.part.removed',
    ])
  })

  // ─── normalisation: session.idle ─────────────────────────────────────

  test('session.idle event publishes normalised event with sessionId', () => {
    const handlers = new Map<string, (event: any) => void>()
    const bus = {
      on(type: string, handler: (event: any) => void) {
        handlers.set(type, handler)
        return () => {}
      },
    }

    const published: OpencodeActivityEvent[] = []
    forwardOpencodeEvents(bus, (e) => published.push(e))

    const idleHandler = handlers.get('session.idle')!
    idleHandler({
      id: 'evt-1',
      type: 'session.idle',
      properties: { sessionID: 'sess-123' },
    })

    expect(published).toHaveLength(1)
    expect(published[0].type).toBe('session.idle')
    expect(published[0].sessionId).toBe('sess-123')
    expect(published[0].title).toBeNull()
    expect(published[0].directory).toBeNull()
    expect(published[0].time).toBeGreaterThan(0)
  })

  // ─── normalisation: session.status ───────────────────────────────────

  test('session.status busy event carries the run status', () => {
    const handlers = new Map<string, (event: any) => void>()
    const bus = {
      on(type: string, handler: (event: any) => void) {
        handlers.set(type, handler)
        return () => {}
      },
    }

    const published: OpencodeActivityEvent[] = []
    forwardOpencodeEvents(bus, (e) => published.push(e))

    handlers.get('session.status')!({
      id: 'evt-s1',
      type: 'session.status',
      properties: { sessionID: 'sess-busy', status: { type: 'busy' } },
    })

    expect(published).toHaveLength(1)
    expect(published[0].type).toBe('session.status')
    expect(published[0].sessionId).toBe('sess-busy')
    expect(published[0].sessionStatus).toBe('busy')
  })

  test('session.status idle event carries idle status', () => {
    const handlers = new Map<string, (event: any) => void>()
    const bus = {
      on(type: string, handler: (event: any) => void) {
        handlers.set(type, handler)
        return () => {}
      },
    }

    const published: OpencodeActivityEvent[] = []
    forwardOpencodeEvents(bus, (e) => published.push(e))

    handlers.get('session.status')!({
      id: 'evt-s2',
      type: 'session.status',
      properties: { sessionID: 'sess-x', status: { type: 'idle' } },
    })

    expect(published).toHaveLength(1)
    expect(published[0].sessionStatus).toBe('idle')
  })

  test('session.status event with unknown status type is dropped', () => {
    const handlers = new Map<string, (event: any) => void>()
    const bus = {
      on(type: string, handler: (event: any) => void) {
        handlers.set(type, handler)
        return () => {}
      },
    }

    const published: OpencodeActivityEvent[] = []
    forwardOpencodeEvents(bus, (e) => published.push(e))

    handlers.get('session.status')!({
      id: 'evt-s3',
      type: 'session.status',
      properties: { sessionID: 'sess-x', status: { type: 'weird' } },
    })

    expect(published).toHaveLength(0)
  })

  // ─── normalisation: session.created (includes info) ──────────────────

  test('session.created event includes title and directory from info', () => {
    const handlers = new Map<string, (event: any) => void>()
    const bus = {
      on(type: string, handler: (event: any) => void) {
        handlers.set(type, handler)
        return () => {}
      },
    }

    const published: OpencodeActivityEvent[] = []
    forwardOpencodeEvents(bus, (e) => published.push(e))

    const createdHandler = handlers.get('session.created')!
    createdHandler({
      id: 'evt-2',
      type: 'session.created',
      properties: {
        sessionID: 'sess-456',
        info: {
          id: 'sess-456',
          title: 'Fix login bug',
          directory: '/home/user/project',
        },
      },
    })

    expect(published).toHaveLength(1)
    expect(published[0].type).toBe('session.created')
    expect(published[0].sessionId).toBe('sess-456')
    expect(published[0].title).toBe('Fix login bug')
    expect(published[0].directory).toBe('/home/user/project')
  })

  // ─── normalisation: session.updated ──────────────────────────────────

  test('session.updated event is normalised the same way', () => {
    const handlers = new Map<string, (event: any) => void>()
    const bus = {
      on(type: string, handler: (event: any) => void) {
        handlers.set(type, handler)
        return () => {}
      },
    }

    const published: OpencodeActivityEvent[] = []
    forwardOpencodeEvents(bus, (e) => published.push(e))

    const updatedHandler = handlers.get('session.updated')!
    updatedHandler({
      id: 'evt-3',
      type: 'session.updated',
      properties: {
        sessionID: 'sess-789',
        info: {
          id: 'sess-789',
          title: 'Updated title',
          directory: '/other/path',
        },
      },
    })

    expect(published).toHaveLength(1)
    expect(published[0].type).toBe('session.updated')
    expect(published[0].sessionId).toBe('sess-789')
    expect(published[0].title).toBe('Updated title')
    expect(published[0].directory).toBe('/other/path')
  })

  // ─── normalisation: session.error (no info, optional sessionID) ──────

  test('session.error event normalises with available properties', () => {
    const handlers = new Map<string, (event: any) => void>()
    const bus = {
      on(type: string, handler: (event: any) => void) {
        handlers.set(type, handler)
        return () => {}
      },
    }

    const published: OpencodeActivityEvent[] = []
    forwardOpencodeEvents(bus, (e) => published.push(e))

    const errorHandler = handlers.get('session.error')!
    errorHandler({
      id: 'evt-4',
      type: 'session.error',
      properties: { sessionID: 'sess-err', error: { message: 'boom' } },
    })

    expect(published).toHaveLength(1)
    expect(published[0].type).toBe('session.error')
    expect(published[0].sessionId).toBe('sess-err')
    expect(published[0].title).toBeNull()
    expect(published[0].directory).toBeNull()
  })

  // ─── missing properties do not crash ─────────────────────────────────

  test('malformed event without properties does not crash', () => {
    const handlers = new Map<string, (event: any) => void>()
    const bus = {
      on(type: string, handler: (event: any) => void) {
        handlers.set(type, handler)
        return () => {}
      },
    }

    const published: OpencodeActivityEvent[] = []
    forwardOpencodeEvents(bus, (e) => published.push(e))

    const idleHandler = handlers.get('session.idle')!
    expect(() => idleHandler({})).not.toThrow()
    expect(published).toHaveLength(1)
    expect(published[0].sessionId).toBeNull()
    expect(published[0].title).toBeNull()
    expect(published[0].directory).toBeNull()
  })

  // ─── detach unsubscribes all ─────────────────────────────────────────

  test('returned detach function unsubscribes all curated event types', () => {
    const unsubscribedTypes: string[] = []
    const bus = {
      on(type: string, _handler: (event: any) => void) {
        return () => {
          unsubscribedTypes.push(type)
        }
      },
    }

    const detach = forwardOpencodeEvents(bus, () => {})
    detach()

    expect(unsubscribedTypes).toEqual([
      'session.idle',
      'session.status',
      'session.created',
      'session.updated',
      'session.error',
      'session.deleted',
      'message.updated',
      'message.part.updated',
      'message.part.removed',
    ])
  })

  // ─── throwing unsubscribe does not break others ──────────────────────

  test('a throwing unsubscribe does not prevent the rest from running', () => {
    let callCount = 0
    const bus = {
      on(_type: string, _handler: (event: any) => void) {
        return () => {
          callCount++
          if (callCount === 2) throw new Error('unsub boom')
        }
      },
    }

    const detach = forwardOpencodeEvents(bus, () => {})
    expect(() => detach()).not.toThrow()
    // All curated unsubscribes were called (one threw, the rest succeeded)
    expect(callCount).toBe(9)
  })

  // ─── each event creates a separate publish call ──────────────────────

  test('multiple events each produce a separate publish', () => {
    const handlers = new Map<string, (event: any) => void>()
    const bus = {
      on(type: string, handler: (event: any) => void) {
        handlers.set(type, handler)
        return () => {}
      },
    }

    const published: OpencodeActivityEvent[] = []
    forwardOpencodeEvents(bus, (e) => published.push(e))

    handlers.get('session.idle')!({
      id: 'e1',
      type: 'session.idle',
      properties: { sessionID: 's1' },
    })
    handlers.get('session.created')!({
      id: 'e2',
      type: 'session.created',
      properties: {
        sessionID: 's2',
        info: { id: 's2', title: 't2', directory: '/d2' },
      },
    })
    handlers.get('session.error')!({
      id: 'e3',
      type: 'session.error',
      properties: { sessionID: 's3' },
    })

    expect(published).toHaveLength(3)
    expect(published[0].sessionId).toBe('s1')
    expect(published[1].sessionId).toBe('s2')
    expect(published[2].sessionId).toBe('s3')
  })
})

describe('forwardGlobalEvents', () => {
  /**
   * Build a stub ForgeClient whose `events.subscribeGlobal` captures the
   * handler so tests can drive events synchronously.
   */
  function stubClient() {
    let handler: ((e: GlobalActivityEvent) => void) | null = null
    let onError: ((err: unknown) => void) | undefined
    const detach = vi.fn()
    const client = {
      events: {
        subscribeGlobal(
          onEvent: (e: GlobalActivityEvent) => void,
          opts?: { onError?: (err: unknown) => void },
        ) {
          handler = onEvent
          onError = opts?.onError
          return detach
        },
      },
    } as unknown as ForgeClient
    return {
      client,
      emit: (e: GlobalActivityEvent) => handler?.(e),
      getOnError: () => onError,
      detach,
    }
  }

  test('forwards curated events, using the wrapper directory as authoritative', () => {
    const { client, emit } = stubClient()
    const published: OpencodeActivityEvent[] = []
    forwardGlobalEvents(client, (e) => published.push(e))

    emit({
      directory: '/proj/from-wrapper',
      payload: {
        type: 'session.idle',
        properties: { info: { id: 'sX', title: 'T', directory: '/proj/from-info' } },
      },
    })

    expect(published).toHaveLength(1)
    expect(published[0].type).toBe('session.idle')
    expect(published[0].sessionId).toBe('sX')
    expect(published[0].title).toBe('T')
    // Wrapper directory wins over info.directory.
    expect(published[0].directory).toBe('/proj/from-wrapper')
  })

  test('falls back to info.directory when wrapper directory is empty', () => {
    const { client, emit } = stubClient()
    const published: OpencodeActivityEvent[] = []
    forwardGlobalEvents(client, (e) => published.push(e))

    emit({
      directory: '',
      payload: {
        type: 'session.created',
        properties: { info: { id: 's1', directory: '/proj/from-info' } },
      },
    })

    expect(published[0].directory).toBe('/proj/from-info')
  })

  test('drops events whose type is not in the allowlist', () => {
    const { client, emit } = stubClient()
    const published: OpencodeActivityEvent[] = []
    forwardGlobalEvents(client, (e) => published.push(e))

    emit({ directory: '/p', payload: { type: 'file.edited', properties: {} } })
    emit({ directory: '/p', payload: { type: 'session.idle', properties: { sessionID: 's' } } })

    expect(published).toHaveLength(1)
    expect(published[0].type).toBe('session.idle')
  })

  test('honors a custom types allowlist', () => {
    const { client, emit } = stubClient()
    const published: OpencodeActivityEvent[] = []
    forwardGlobalEvents(client, (e) => published.push(e), { types: ['message.updated'] })

    emit({ directory: '/p', payload: { type: 'session.idle', properties: {} } })
    emit({
      directory: '/p',
      payload: { type: 'message.updated', properties: { info: { id: 'm1', sessionID: 's1', role: 'assistant' } } },
    })

    expect(published).toHaveLength(1)
    expect(published[0].type).toBe('message.updated')
  })

  test('returns the port detach function and forwards onError', () => {
    const { client, detach, getOnError } = stubClient()
    const onError = vi.fn()
    const returned = forwardGlobalEvents(client, () => {}, { onError })

    expect(returned).toBe(detach)
    // The onError passed to the port is the caller's onError.
    expect(getOnError()).toBe(onError)
  })

  test('session.created carries a session row built from info', () => {
    const { client, emit } = stubClient()
    const published: OpencodeActivityEvent[] = []
    forwardGlobalEvents(client, (e) => published.push(e))

    emit({
      directory: '/proj/wt',
      payload: {
        type: 'session.created',
        properties: {
          info: { id: 's1', title: 'My session', directory: '/proj/from-info', time: { created: 5, updated: 9 } },
        },
      },
    })

    expect(published).toHaveLength(1)
    const session = published[0].session!
    expect(session.id).toBe('s1')
    expect(session.title).toBe('My session')
    // Wrapper directory is authoritative; projectName derives from its basename.
    expect(session.directory).toBe('/proj/wt')
    expect(session.projectName).toBe('wt')
    expect(session.timeCreated).toBe(5)
    expect(session.timeUpdated).toBe(9)
    // Cost/token fields are absent from session events and default to 0.
    expect(session.cost).toBe(0)
    expect(session.tokensInput).toBe(0)
  })

  test('session.idle has a null session row (no info payload)', () => {
    const { client, emit } = stubClient()
    const published: OpencodeActivityEvent[] = []
    forwardGlobalEvents(client, (e) => published.push(e))

    emit({ directory: '/p', payload: { type: 'session.idle', properties: { sessionID: 's' } } })

    expect(published).toHaveLength(1)
    expect(published[0].session).toBeNull()
  })

  test('message.part.updated carries a mapped transcript entry scoped to its session', () => {
    const { client, emit } = stubClient()
    const published: OpencodeActivityEvent[] = []
    forwardGlobalEvents(client, (e) => published.push(e))

    emit({
      directory: '/p',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'text',
            text: 'streaming…',
            time: { start: 42 },
          },
        },
      },
    })

    expect(published).toHaveLength(1)
    const event = published[0]
    expect(event.type).toBe('message.part.updated')
    expect(event.sessionId).toBe('ses_1')
    const part = event.part!
    expect(part.sessionId).toBe('ses_1')
    expect(part.partId).toBe('prt_1')
    expect(part.entry).toEqual({
      partId: 'prt_1',
      messageId: 'msg_1',
      role: null,
      model: null,
      type: 'text',
      text: 'streaming…',
      toolName: null,
      toolTitle: null,
      toolStatus: null,
      timeCreated: 42,
    })
  })

  test('message.updated carries role + model metadata for its session', () => {
    const { client, emit } = stubClient()
    const published: OpencodeActivityEvent[] = []
    forwardGlobalEvents(client, (e) => published.push(e))

    emit({
      directory: '/p',
      payload: {
        type: 'message.updated',
        properties: {
          info: { id: 'msg_1', sessionID: 'ses_1', role: 'assistant', modelID: 'claude-opus-4-8' },
        },
      },
    })

    expect(published).toHaveLength(1)
    expect(published[0].type).toBe('message.updated')
    expect(published[0].sessionId).toBe('ses_1')
    expect(published[0].messageMeta).toEqual({
      sessionId: 'ses_1',
      messageId: 'msg_1',
      role: 'assistant',
      model: 'claude-opus-4-8',
    })
  })

  test('message.part.updated for a non-rendered part type is dropped', () => {
    const { client, emit } = stubClient()
    const published: OpencodeActivityEvent[] = []
    forwardGlobalEvents(client, (e) => published.push(e))

    emit({
      directory: '/p',
      payload: {
        type: 'message.part.updated',
        properties: { part: { id: 'p', sessionID: 's', messageID: 'm', type: 'step-start' } },
      },
    })

    expect(published).toHaveLength(0)
  })

  test('message.part.removed carries a null entry for removal', () => {
    const { client, emit } = stubClient()
    const published: OpencodeActivityEvent[] = []
    forwardGlobalEvents(client, (e) => published.push(e))

    emit({
      directory: '/p',
      payload: {
        type: 'message.part.removed',
        properties: { sessionID: 'ses_1', messageID: 'msg_1', partID: 'prt_1' },
      },
    })

    expect(published).toHaveLength(1)
    expect(published[0].sessionId).toBe('ses_1')
    expect(published[0].part).toEqual({
      sessionId: 'ses_1',
      messageId: 'msg_1',
      partId: 'prt_1',
      entry: null,
    })
  })
})

describe('startActivityForwarding', () => {
  function stubClient() {
    let handler: ((e: GlobalActivityEvent) => void) | null = null
    let onError: ((err: unknown) => void) | undefined
    const detach = vi.fn()
    const client = {
      events: {
        subscribeGlobal(
          onEvent: (e: GlobalActivityEvent) => void,
          opts?: { onError?: (err: unknown) => void },
        ) {
          handler = onEvent
          onError = opts?.onError
          return detach
        },
      },
    } as unknown as ForgeClient
    return { client, emit: (e: GlobalActivityEvent) => handler?.(e), getOnError: () => onError, detach }
  }

  function stubBus() {
    const handlers = new Map<string, (e: any) => void>()
    const bus = {
      on(type: string, handler: (e: any) => void) {
        handlers.set(type, handler)
        return () => {}
      },
    }
    return { bus, handlers }
  }

  test('source "none" returns a no-op detach and subscribes to nothing', () => {
    const { client } = stubClient()
    const { bus, handlers } = stubBus()
    const published: OpencodeActivityEvent[] = []

    const detach = startActivityForwarding(
      { source: 'none' },
      { publish: (e) => published.push(e), client, eventBus: bus },
    )

    expect(handlers.size).toBe(0)
    expect(() => detach()).not.toThrow()
    expect(published).toHaveLength(0)
  })

  test('source "tui" subscribes to the event bus', () => {
    const { bus, handlers } = stubBus()
    startActivityForwarding({ source: 'tui' }, { publish: () => {}, eventBus: bus })
    expect([...handlers.keys()]).toContain('session.idle')
  })

  test('source "server" (default) uses the global stream', () => {
    const { client, emit } = stubClient()
    const published: OpencodeActivityEvent[] = []

    startActivityForwarding({}, { publish: (e) => published.push(e), client })

    emit({ directory: '/p', payload: { type: 'session.idle', properties: { sessionID: 's' } } })
    expect(published).toHaveLength(1)
    expect(published[0].directory).toBe('/p')
  })

  test('server source with no client falls back to the TUI bus', () => {
    const { bus, handlers } = stubBus()
    startActivityForwarding({ source: 'server' }, { publish: () => {}, eventBus: bus })
    expect([...handlers.keys()]).toContain('session.idle')
  })

  test('server source falls back to the TUI bus when global is unavailable', () => {
    const { client, getOnError } = stubClient()
    const { bus, handlers } = stubBus()
    startActivityForwarding({ source: 'server' }, { publish: () => {}, client, eventBus: bus })

    // No fallback until the unavailable error is reported.
    expect(handlers.size).toBe(0)

    getOnError()?.(new ForgeClientError({ kind: 'unavailable', method: 'events.subscribeGlobal', message: 'x' }))
    expect([...handlers.keys()]).toContain('session.idle')
  })
})
