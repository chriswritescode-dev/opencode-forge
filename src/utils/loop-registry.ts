/**
 * Loop registry for tracking loops started/restarted in the current plugin process.
 *
 * This registry is used to gate sandbox reconciliation and other runtime operations
 * so they only affect loops that were started or restarted during the current plugin
 * process, not pre-existing persisted loops from before plugin initialization.
 *
 * Entries are grouped by project id: loop names are only unique within a project, and
 * one OpenCode process can host several projects.
 */

import { processShared } from './process-shared'

const activeLoops = processShared('loop-registry.v2', () => new Map<string, Set<string>>())

export const loopRegistry = {
  /**
   * Register a loop as started/restarted in the current process.
   */
  add(projectId: string, loopName: string): void {
    let names = activeLoops.get(projectId)
    if (!names) {
      names = new Set()
      activeLoops.set(projectId, names)
    }
    names.add(loopName)
  },

  /**
   * Remove a loop from the registry (e.g., on termination).
   */
  remove(projectId: string, loopName: string): void {
    const names = activeLoops.get(projectId)
    if (!names) return
    names.delete(loopName)
    if (names.size === 0) activeLoops.delete(projectId)
  },

  /**
   * Check if a loop was started/restarted in the current process.
   */
  has(projectId: string, loopName: string): boolean {
    return activeLoops.get(projectId)?.has(loopName) ?? false
  },

  /**
   * Get all registered loop names for a project.
   */
  getAll(projectId: string): string[] {
    return Array.from(activeLoops.get(projectId) ?? [])
  },

  /**
   * Clear all registered loops (useful for testing).
   */
  clear(): void {
    activeLoops.clear()
  },
}
