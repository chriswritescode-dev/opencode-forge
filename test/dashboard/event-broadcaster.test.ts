import { describe, test, expect } from 'vitest'
import { createEventBroadcaster } from '../../src/dashboard/event-broadcaster'
import type { OpencodeActivityEvent } from '../../src/observability/types'

function makeEvent(overrides?: Partial<OpencodeActivityEvent>): OpencodeActivityEvent {
  return {
    type: 'session_created',
    sessionId: null,
    time: Date.now(),
    ...overrides,
  }
}

describe('createEventBroadcaster', () => {
  // ─── publish fans out to all subscribers ──────────────────────────────

  test('publish sends event to all subscribers', () => {
    const b = createEventBroadcaster()
    const received1: OpencodeActivityEvent[] = []
    const received2: OpencodeActivityEvent[] = []

    b.subscribe((e) => received1.push(e))
    b.subscribe((e) => received2.push(e))

    const event = makeEvent({ type: 'test_event' })
    b.publish(event)

    expect(received1).toHaveLength(1)
    expect(received1[0].type).toBe('test_event')
    expect(received2).toHaveLength(1)
    expect(received2[0].type).toBe('test_event')
  })

  // ─── throwing subscriber does not break others ────────────────────────

  test('a throwing subscriber does not prevent others from receiving', () => {
    const b = createEventBroadcaster()
    const received: OpencodeActivityEvent[] = []

    b.subscribe(() => { throw new Error('boom') })
    b.subscribe((e) => received.push(e))

    const event = makeEvent({ type: 'survived' })
    expect(() => b.publish(event)).not.toThrow()
    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('survived')
  })

  // ─── subscribe returns working unsubscribe ───────────────────────────

  test('unsubscribed subscriber stops receiving events', () => {
    const b = createEventBroadcaster()
    const received: OpencodeActivityEvent[] = []

    const unsub = b.subscribe((e) => received.push(e))
    unsub()

    b.publish(makeEvent({ type: 'after_unsub' }))
    expect(received).toHaveLength(0)
  })

  test('clientCount() reflects current subscriber count', () => {
    const b = createEventBroadcaster()
    expect(b.clientCount()).toBe(0)

    const unsub1 = b.subscribe(() => {})
    expect(b.clientCount()).toBe(1)

    const unsub2 = b.subscribe(() => {})
    expect(b.clientCount()).toBe(2)

    unsub1()
    expect(b.clientCount()).toBe(1)

    unsub2()
    expect(b.clientCount()).toBe(0)
  })

  // ─── ring buffer capping ─────────────────────────────────────────────

  test('recent() returns events in insertion order', () => {
    const b = createEventBroadcaster({ bufferSize: 10 })
    const events: OpencodeActivityEvent[] = []

    for (let i = 0; i < 5; i++) {
      const e = makeEvent({ type: `evt-${i}`, time: 1000 + i })
      events.push(e)
      b.publish(e)
    }

    const recent = b.recent()
    expect(recent).toHaveLength(5)
    expect(recent[0].type).toBe('evt-0')
    expect(recent[4].type).toBe('evt-4')
  })

  test('ring buffer caps at bufferSize, retaining most recent events', () => {
    const b = createEventBroadcaster({ bufferSize: 3 })

    for (let i = 0; i < 10; i++) {
      b.publish(makeEvent({ type: `evt-${i}`, time: 1000 + i }))
    }

    const recent = b.recent()
    expect(recent).toHaveLength(3)
    // Should be the last 3 events
    expect(recent[0].type).toBe('evt-7')
    expect(recent[1].type).toBe('evt-8')
    expect(recent[2].type).toBe('evt-9')
  })

  test('recent() returns empty array when no events published', () => {
    const b = createEventBroadcaster()
    expect(b.recent()).toEqual([])
  })

  // ─── close behaviour ─────────────────────────────────────────────────

  test('close clears subscribers and buffer', () => {
    const b = createEventBroadcaster()
    const received: OpencodeActivityEvent[] = []

    b.subscribe((e) => received.push(e))
    b.publish(makeEvent({ type: 'before_close' }))
    expect(received).toHaveLength(1)

    b.close()

    // Buffer is empty after close
    expect(b.recent()).toEqual([])
    expect(b.clientCount()).toBe(0)

    // Publish after close — subscribers are gone so no new deliveries,
    // but the ring buffer will hold the new event (close does not freeze).
    b.publish(makeEvent({ type: 'after_close' }))
    expect(received).toHaveLength(1) // no new events delivered
    expect(b.clientCount()).toBe(0)
    expect(b.recent()).toHaveLength(1)
    expect(b.recent()[0].type).toBe('after_close')
  })

  // ─── default buffer size ─────────────────────────────────────────────

  test('default buffer size is 100', () => {
    const b = createEventBroadcaster()
    // Fill beyond default capacity
    for (let i = 0; i < 150; i++) {
      b.publish(makeEvent({ type: `evt-${i}`, time: 1000 + i }))
    }
    expect(b.recent()).toHaveLength(100)
  })

  // ─── bufferSize of 0 is clamped to 1 ─────────────────────────────────

  test('bufferSize 0 is clamped to minimum of 1', () => {
    const b = createEventBroadcaster({ bufferSize: 0 })
    b.publish(makeEvent({ type: 'a' }))
    b.publish(makeEvent({ type: 'b' }))
    expect(b.recent()).toHaveLength(1)
    expect(b.recent()[0].type).toBe('b')
  })
})
