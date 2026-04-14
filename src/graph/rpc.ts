/// <reference types="bun-types" />

import { EventEmitter } from 'events'

/**
 * Per-call RPC timeout in milliseconds.
 * This timeout applies to individual RPC method calls, not to multi-step operations like batch scans.
 * Configure via GRAPH_RPC_TIMEOUT_MS environment variable.
 * Default: 120000 (120 seconds)
 */
export const RPC_TIMEOUT_MS = parseInt(process.env.GRAPH_RPC_TIMEOUT_MS ?? '120000', 10)

/**
 * Generic RPC client for worker communication
 * Simplified from SoulForge without Zustand store references
 */
export class RpcClient extends EventEmitter {
  private worker: Worker
  private pendingCalls: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }> = new Map()
  private callId = 0
  private workerTerminated = false
  private workerError: Error | null = null

  constructor(worker: Worker, private logger?: { error: (msg: string, error?: unknown) => void; debug?: (msg: string) => void }) {
    super()
    this.worker = worker
    this.setupWorkerHandlers()
  }

  private setupWorkerHandlers(): void {
    this.worker.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data)
    }
    
    this.worker.onerror = (error: ErrorEvent) => {
      this.workerError = error instanceof Error ? error : new Error(error.message || 'Worker error')
      this.logger?.error('Worker error occurred', this.workerError)
      this.rejectAllPending(new Error(`Worker error: ${this.workerError.message}`))
      this.emit('error', error)
    }

    // Handle worker termination
    this.worker.addEventListener('messageerror', () => {
      this.workerTerminated = true
      this.logger?.error('Worker message error - worker may be terminated')
      this.rejectAllPending(new Error('Worker terminated'))
    })
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pendingCalls.entries()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pendingCalls.clear()
  }

  private handleMessage(data: unknown): void {
    if (data && typeof data === 'object' && 'callId' in data) {
      const msg = data as { callId: number; result?: unknown; error?: string; event?: string; payload?: unknown }
      
      if (msg.event) {
        // Handle events from worker
        this.emit(msg.event, msg.payload)
        return
      }

      const pending = this.pendingCalls.get(msg.callId)
      if (pending) {
        clearTimeout(pending.timeout)
        this.pendingCalls.delete(msg.callId)
        if (msg.error) {
          pending.reject(new Error(msg.error))
        } else {
          pending.resolve(msg.result)
        }
      }
    }
  }

  async call<T>(method: string, args: unknown[]): Promise<T> {
    if (this.workerTerminated) {
      throw new Error('Worker has been terminated')
    }
    if (this.workerError) {
      throw new Error(`Worker error: ${this.workerError.message}`)
    }

    const callId = ++this.callId
    const message = { callId, method, args }

    return new Promise<T>((resolve: (value: T) => void, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCalls.delete(callId)
        reject(new Error(`RPC call '${method}' timed out after ${RPC_TIMEOUT_MS}ms`))
      }, RPC_TIMEOUT_MS)

      this.pendingCalls.set(callId, { resolve: resolve as (value: unknown) => void, reject, timeout })
      
      try {
        this.worker.postMessage(message)
      } catch (error) {
        clearTimeout(timeout)
        this.pendingCalls.delete(callId)
        this.workerTerminated = true
        const postError = error instanceof Error ? error : new Error(String(error))
        this.workerError = postError // Set error for consistent state tracking
        this.logger?.error('Failed to post message to worker', postError)
        this.rejectAllPending(postError)
        reject(postError)
      }
    })
  }

  terminate(): void {
    this.workerTerminated = true
    this.worker.terminate()
  }

  isHealthy(): boolean {
    return !this.workerTerminated && this.workerError === null
  }

  markTerminated(): void {
    this.workerTerminated = true
    this.rejectAllPending(new Error('Worker terminated'))
  }
}

/**
 * RPC server for worker side
 */
export class RpcServer {
  private handlers: Map<string, (args: unknown[]) => Promise<unknown> | unknown> = new Map()

  register(method: string, handler: (args: unknown[]) => Promise<unknown> | unknown): void {
    this.handlers.set(method, handler)
  }

  async handle(message: unknown, postResponse: (response: unknown) => void): Promise<void> {
    if (!message || typeof message !== 'object') return

    const msg = message as { callId: number; method: string; args: unknown[] }
    const { callId, method, args } = msg

    try {
      const handler = this.handlers.get(method)
      if (!handler) {
        throw new Error(`Unknown method: ${method}`)
      }

      const result = await handler(args)
      postResponse({ callId, result })
    } catch (error) {
      postResponse({
        callId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  emit(_event: string, _payload?: unknown): void {
    // Will be called from worker to emit events to client
  }
}
