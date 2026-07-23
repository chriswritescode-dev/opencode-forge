import type { Database } from 'bun:sqlite'

/**
 * Runs `fn` inside a `BEGIN IMMEDIATE` transaction so multi-statement checks
 * and writes execute under a single reserved write lock. `db.transaction(fn)`
 * returns a function plus `.immediate` / `.deferred` / `.exclusive` variants;
 * bun-types does not surface those properties on the inferred call signature
 * under this tsconfig, so cast explicitly. Passing a fresh closure per call
 * lets callers capture their arguments directly instead of staging them in
 * mutable module state.
 */
export function runImmediateTransaction<T>(db: Database, fn: () => T): T {
  const run = db.transaction(fn) as unknown as {
    (): T
    immediate: () => T
    deferred: () => T
    exclusive: () => T
  }
  return run.immediate()
}
