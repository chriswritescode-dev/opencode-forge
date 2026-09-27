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
