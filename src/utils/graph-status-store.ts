/**
 * Graph status store for persisting and reading graph service state.
 * 
 * This module provides helpers for persisting graph service lifecycle state
 * to the shared project KV store, allowing the TUI to display real-time
 * graph readiness without direct backend coupling.
 */

import type { KvService } from '../services/kv'

/**
 * Graph service state enumeration
 */
export type GraphState = 'unavailable' | 'initializing' | 'indexing' | 'ready' | 'error'

/**
 * Graph statistics payload
 */
export interface GraphStatsPayload {
  files: number
  symbols: number
  edges: number
  calls: number
}

/**
 * Persisted graph status payload
 */
export interface GraphStatusPayload {
  /** Current state of the graph service */
  state: GraphState
  /** Whether the graph is ready for queries */
  ready: boolean
  /** Optional statistics about the graph */
  stats?: GraphStatsPayload
  /** Optional human-readable status or error message */
  message?: string
  /** Timestamp of the last status update */
  updatedAt: number
}

/**
 * Default unavailable status used when graph is disabled or not yet initialized
 */
export const UNAVAILABLE_STATUS: GraphStatusPayload = {
  state: 'unavailable',
  ready: false,
  updatedAt: 0,
}

/**
 * Key used for storing graph status in the project KV store
 */
export const GRAPH_STATUS_KEY = 'graph:status'

/**
 * Writes graph status to the project KV store.
 * 
 * @param kvService - The KV service instance
 * @param projectId - The project ID
 * @param status - The status payload to persist
 */
export function writeGraphStatus(
  kvService: KvService,
  projectId: string,
  status: GraphStatusPayload
): void {
  kvService.set(projectId, GRAPH_STATUS_KEY, status)
}

/**
 * Reads graph status from the project KV store.
 * 
 * @param kvService - The KV service instance
 * @param projectId - The project ID
 * @returns The status payload or null if not found
 */
export function readGraphStatus(
  kvService: KvService,
  projectId: string
): GraphStatusPayload | null {
  return kvService.get<GraphStatusPayload>(projectId, GRAPH_STATUS_KEY)
}

/**
 * Creates a status callback function that persists graph state changes.
 * 
 * This factory function returns a callback that can be passed to the graph
 * service to automatically persist state transitions to the KV store.
 * 
 * @param kvService - The KV service instance
 * @param projectId - The project ID
 * @returns A callback function for status updates
 */
export function createGraphStatusCallback(
  kvService: KvService,
  projectId: string
): (state: GraphState, stats?: GraphStatsPayload, message?: string) => void {
  return (state: GraphState, stats?: GraphStatsPayload, message?: string) => {
    const status: GraphStatusPayload = {
      state,
      ready: state === 'ready',
      stats,
      message,
      updatedAt: Date.now(),
    }
    writeGraphStatus(kvService, projectId, status)
  }
}
