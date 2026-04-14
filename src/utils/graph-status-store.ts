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
 * Base key used for storing graph status in the project KV store
 */
export const GRAPH_STATUS_KEY = 'graph:status'

/**
 * Creates a scoped graph status key by combining the base key with an optional cwd.
 * This allows separate graph status tracking for worktree sessions vs root sessions.
 * 
 * @param cwd - Optional working directory scope
 * @returns The scoped status key
 */
export function getGraphStatusKey(cwd?: string): string {
  if (!cwd) return GRAPH_STATUS_KEY
  const normalizedCwd = cwd.replace(/\/$/, '')
  return `${GRAPH_STATUS_KEY}:${normalizedCwd}`
}

/**
 * Writes graph status to the project KV store.
 * 
 * @param kvService - The KV service instance
 * @param projectId - The project ID
 * @param status - The status payload to persist
 * @param cwd - Optional working directory scope for worktree sessions
 */
export function writeGraphStatus(
  kvService: KvService,
  projectId: string,
  status: GraphStatusPayload,
  cwd?: string
): void {
  const key = getGraphStatusKey(cwd)
  kvService.set(projectId, key, status)
}

/**
 * Reads graph status from the project KV store.
 * 
 * @param kvService - The KV service instance
 * @param projectId - The project ID
 * @param cwd - Optional working directory scope for worktree sessions
 * @returns The status payload or null if not found
 */
export function readGraphStatus(
  kvService: KvService,
  projectId: string,
  cwd?: string
): GraphStatusPayload | null {
  const key = getGraphStatusKey(cwd)
  return kvService.get<GraphStatusPayload>(projectId, key)
}

/**
 * Creates a status callback function that persists graph state changes.
 * 
 * This factory function returns a callback that can be passed to the graph
 * service to automatically persist state transitions to the KV store.
 * 
 * @param kvService - The KV service instance
 * @param projectId - The project ID
 * @param cwd - Optional working directory scope for worktree sessions
 * @returns A callback function for status updates
 */
export function createGraphStatusCallback(
  kvService: KvService,
  projectId: string,
  cwd?: string
): (state: GraphState, stats?: GraphStatsPayload, message?: string) => void {
  return (state: GraphState, stats?: GraphStatsPayload, message?: string) => {
    const status: GraphStatusPayload = {
      state,
      ready: state === 'ready',
      stats,
      message,
      updatedAt: Date.now(),
    }
    writeGraphStatus(kvService, projectId, status, cwd)
  }
}

/**
 * Determines if a graph status is transient (still being built).
 * Transient states indicate the graph is still being built and should
 * trigger continued waiting or polling.
 * 
 * @param status - The graph status payload or null
 * @returns true if status is initializing or indexing, false otherwise
 */
export function isGraphTransient(status: GraphStatusPayload | null): boolean {
  if (!status) return false
  return status.state === 'initializing' || status.state === 'indexing'
}

/**
 * Determines if a graph status is ready for queries.
 * 
 * @param status - The graph status payload or null
 * @returns true if status is ready, false otherwise
 */
export function isGraphReady(status: GraphStatusPayload | null): boolean {
  if (!status) return false
  return status.state === 'ready'
}
