import type { OpencodeActivityEvent } from '../observability/types'

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface EventBroadcaster {
  /** Send an event to all active subscribers. */
  publish(event: OpencodeActivityEvent): void

  /**
   * Register a subscriber that receives every future event.
   * Returns an unsubscribe function that removes the subscriber.
   */
  subscribe(send: (event: OpencodeActivityEvent) => void): () => void

  /** Return the most recent events in insertion order (oldest first). */
  recent(): OpencodeActivityEvent[]

  /** Number of currently active subscribers. */
  clientCount(): number

  /** Remove all subscribers and clear the event buffer. */
  close(): void
}

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

/**
 * Fixed-capacity ring buffer that retains the most recently pushed items.
 * `values()` returns items in insertion order (oldest first) — useful for
 * replaying events to late-joining subscribers.
 */
class RingBuffer<T> {
  private readonly buf: (T | undefined)[]
  private write = 0
  private size = 0

  constructor(capacity: number) {
    this.buf = new Array<T | undefined>(capacity)
  }

  push(value: T): void {
    this.buf[this.write] = value
    this.write = (this.write + 1) % this.buf.length
    if (this.size < this.buf.length) this.size++
  }

  values(): T[] {
    if (this.size === 0) return []
    const len = this.buf.length
    // Not yet wrapped → return [0 .. size)
    if (this.size < len) {
      const out: T[] = new Array(this.size)
      for (let i = 0; i < this.size; i++) out[i] = this.buf[i]!
      return out
    }
    // Wrapped → return [write .. end) then [0 .. write)
    const out: T[] = new Array(len)
    let idx = 0
    for (let i = this.write; i < len; i++) out[idx++] = this.buf[i]!
    for (let i = 0; i < this.write; i++) out[idx++] = this.buf[i]!
    return out
  }

  clear(): void {
    this.buf.fill(undefined)
    this.write = 0
    this.size = 0
  }

  get capacity(): number {
    return this.buf.length
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an event broadcaster backed by a bounded ring buffer.
 *
 * @param opts.bufferSize  Maximum number of recent events to retain (default 100).
 */
export function createEventBroadcaster(opts?: { bufferSize?: number }): EventBroadcaster {
  const capacity = Math.max(1, opts?.bufferSize ?? 100)
  const ring = new RingBuffer<OpencodeActivityEvent>(capacity)
  const subscribers = new Set<(event: OpencodeActivityEvent) => void>()

  function publish(event: OpencodeActivityEvent): void {
    ring.push(event)

    // Fan out – a throwing subscriber must not break others.
    for (const sub of subscribers) {
      try {
        sub(event)
      } catch {
        // subscriber error swallowed
      }
    }
  }

  function subscribe(send: (event: OpencodeActivityEvent) => void): () => void {
    subscribers.add(send)
    return () => {
      subscribers.delete(send)
    }
  }

  function recent(): OpencodeActivityEvent[] {
    return ring.values()
  }

  function clientCount(): number {
    return subscribers.size
  }

  function close(): void {
    subscribers.clear()
    ring.clear()
  }

  return { publish, subscribe, recent, clientCount, close }
}
