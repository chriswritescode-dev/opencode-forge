/**
 * Returns the value stored under `key` for the whole process, creating it on first use.
 *
 * OpenCode loads a separate copy of the plugin's module graph for each location, all in one
 * process, so module-level state is per location. State that must be one per process (the
 * per-project host sandbox controller, idle-gate markers, prompt in-flight guards) lives on
 * `globalThis` under a registered symbol so every module copy resolves the same value. Bump the
 * key's version suffix when the stored shape changes, so copies from different builds never share
 * an incompatible value.
 */
export function processShared<T>(key: string, create: () => T): T {
  const scope = globalThis as Record<symbol, unknown>
  const symbol = Symbol.for(`opencode-forge.${key}`)
  return (scope[symbol] ??= create()) as T
}

/**
 * Builds the key for process-shared state that is scoped to one loop. Loop names are only
 * unique within a project, and one OpenCode process can host several projects, so shared
 * maps must key entries by project AND loop name to keep same-named loops independent.
 */
export function projectLoopKey(projectId: string, loopName: string): string {
  return `${projectId}\u0000${loopName}`
}

/**
 * Builds the key for process-shared state scoped to one section run of one loop. A lane is a
 * loop plus a section-run key, so state for the same loop keeps one independent entry per
 * section run instead of sharing a single entry across every run.
 */
export function projectLoopLaneKey(projectId: string, lane: { loopName: string; sectionRunKey: string }): string {
  return `${projectLoopKey(projectId, lane.loopName)}\u0000${lane.sectionRunKey}`
}

/**
 * Removes every lane-scoped entry for one loop and returns the removed values so callers can
 * report what they cleared. Entries of other loops, and of same-named loops in other projects,
 * stay untouched.
 */
export function deleteLoopLaneEntries<V>(map: Map<string, V>, projectId: string, loopName: string): V[] {
  const prefix = `${projectLoopKey(projectId, loopName)}\u0000`
  const removed: V[] = []
  for (const [key, value] of map) {
    if (key.startsWith(prefix)) {
      map.delete(key)
      removed.push(value)
    }
  }
  return removed
}
