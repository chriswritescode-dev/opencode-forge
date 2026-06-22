import { describe, test, expect } from 'vitest'
import { forwardOpencodeEvents } from '../../src/dashboard/opencode-events'
import type { OpencodeActivityEvent } from '../../src/observability/types'

describe('forwardOpencodeEvents', () => {
  // ─── subscribes to all four curated event types ───────────────────────

  test('subscribes to session.idle, session.created, session.updated, session.error', () => {
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
      'session.created',
      'session.updated',
      'session.error',
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

  test('returned detach function unsubscribes all four event types', () => {
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
      'session.created',
      'session.updated',
      'session.error',
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
    // All four unsubscribes were called (three succeeded, one threw)
    expect(callCount).toBe(4)
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
