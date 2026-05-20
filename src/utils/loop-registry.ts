/**
 * Loop registry for tracking loops started/restarted in the current plugin process.
 * 
 * This registry is used to gate sandbox reconciliation and other runtime operations
 * so they only affect loops that were started or restarted during the current plugin
 * process, not pre-existing persisted loops from before plugin initialization.
 */

const activeLoops = new Set<string>()

export const loopRegistry = {
  /**
   * Register a loop as started/restarted in the current process.
   */
  add(loopName: string): void {
    activeLoops.add(loopName)
  },

  /**
   * Remove a loop from the registry (e.g., on termination).
   */
  remove(loopName: string): void {
    activeLoops.delete(loopName)
  },

  /**
   * Check if a loop was started/restarted in the current process.
   */
  has(loopName: string): boolean {
    return activeLoops.has(loopName)
  },

  /**
   * Get all registered loop names.
   */
  getAll(): string[] {
    return Array.from(activeLoops)
  },

  /**
   * Clear all registered loops (useful for testing).
   */
  clear(): void {
    activeLoops.clear()
  },
}
