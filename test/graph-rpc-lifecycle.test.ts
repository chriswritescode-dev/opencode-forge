import { describe, test, expect } from 'bun:test'
import { RpcClient } from '../src/graph/rpc'
import type { Logger } from '../src/types'

describe('RPC client error handling', () => {
  test('should reject pending calls when markTerminated is called', async () => {
    // Create a mock worker
    const mockWorker = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null as ((error: ErrorEvent) => void) | null,
      postMessage: () => {},
      terminate: () => {},
      addEventListener: () => {},
    } as unknown as Worker

    const logger: Logger = {
      log: () => {},
      error: () => {},
      debug: () => {},
    }

    const client = new RpcClient(mockWorker, logger)
    
    // Start an RPC call
    const promise = client.call('test', [])
    
    // Mark as terminated
    client.markTerminated()
    
    // Promise should reject
    await expect(promise).rejects.toThrow('Worker terminated')
  })

  test('should throw on call when worker has error', async () => {
    const mockWorker = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null as ((error: ErrorEvent) => void) | null,
      postMessage: () => {},
      terminate: () => {},
      addEventListener: () => {},
    } as unknown as Worker

    const logger: Logger = {
      log: () => {},
      error: () => {},
      debug: () => {},
    }

    const client = new RpcClient(mockWorker, logger)
    
    // Manually set worker error
    const error = new Error('Test error')
    // Access private property via type assertion workaround
    ;(client as unknown as { workerError: Error | null }).workerError = error
    
    // Calling should throw
    await expect(client.call('test', [])).rejects.toThrow('Test error')
  })

  test('should throw on call when worker is terminated', async () => {
    const mockWorker = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null as ((error: ErrorEvent) => void) | null,
      postMessage: () => {},
      terminate: () => {},
      addEventListener: () => {},
    } as unknown as Worker

    const logger: Logger = {
      log: () => {},
      error: () => {},
      debug: () => {},
    }

    const client = new RpcClient(mockWorker, logger)
    
    // Manually mark as terminated
    client.markTerminated()
    
    // Calling should throw
    await expect(client.call('test', [])).rejects.toThrow('Worker has been terminated')
  })

  test('isHealthy should return false after markTerminated', () => {
    const mockWorker = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null as ((error: ErrorEvent) => void) | null,
      postMessage: () => {},
      terminate: () => {},
      addEventListener: () => {},
    } as unknown as Worker

    const logger: Logger = {
      log: () => {},
      error: () => {},
      debug: () => {},
    }

    const client = new RpcClient(mockWorker, logger)
    
    expect(client.isHealthy()).toBe(true)
    
    client.markTerminated()
    
    expect(client.isHealthy()).toBe(false)
  })
})
