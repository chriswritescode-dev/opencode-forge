import { processShared } from './process-shared'

const activeLoops = processShared('loop-registry.v2', () => new Map<string, Set<string>>())

export const loopRegistry = {
  add(projectId: string, loopName: string): void {
    let names = activeLoops.get(projectId)
    if (!names) {
      names = new Set()
      activeLoops.set(projectId, names)
    }
    names.add(loopName)
  },

  remove(projectId: string, loopName: string): void {
    const names = activeLoops.get(projectId)
    if (!names) return
    names.delete(loopName)
    if (names.size === 0) activeLoops.delete(projectId)
  },

  has(projectId: string, loopName: string): boolean {
    return activeLoops.get(projectId)?.has(loopName) ?? false
  },

  getAll(projectId: string): string[] {
    return Array.from(activeLoops.get(projectId) ?? [])
  },

  clear(): void {
    activeLoops.clear()
  },
}
