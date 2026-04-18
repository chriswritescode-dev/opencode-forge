/**
 * Sandbox readiness helper for TUI loop launches.
 * 
 * This module provides a function to wait for a sandbox container to be ready
 * by polling the loops.sandbox_container field.
 */

import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'

export interface WaitForSandboxOptions {
  projectId: string
  loopName: string
  dbPath: string
  pollMs?: number       // default 200
  timeoutMs?: number    // default 15000
}

export type WaitForSandboxResult =
  | { ready: true; containerName: string }
  | { ready: false; reason: 'timeout' | 'state_missing' | 'not_sandbox_enabled' | 'db_missing' }

/**
 * Waits for a sandbox container to be ready by polling the loops table.
 * 
 * This function polls the loops table for a loop's sandbox_container field,
 * which is written by the plugin server's sandbox reconciliation process.
 * 
 * @param opts - Wait options including project ID, loop name, and timing
 * @returns Promise resolving to a WaitForSandboxResult
 */
export async function waitForSandboxReady(opts: WaitForSandboxOptions): Promise<WaitForSandboxResult> {
  const { projectId, loopName, dbPath } = opts
  const pollMs = opts.pollMs ?? 200
  const timeoutMs = opts.timeoutMs ?? 15000
  const startTime = Date.now()

  // Check if database exists
  if (!existsSync(dbPath)) {
    return { ready: false, reason: 'db_missing' }
  }

  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    db.run('PRAGMA busy_timeout=5000')

    while (true) {
      // Query for loop sandbox_container from loops table
      const row = db.prepare(
        'SELECT sandbox, sandbox_container FROM loops WHERE project_id = ? AND loop_name = ?'
      ).get(projectId, loopName) as { sandbox: number; sandbox_container: string | null } | null

      if (!row) {
        // State is missing - check if we should timeout
        if (Date.now() - startTime > timeoutMs) {
          return { ready: false, reason: 'timeout' }
        }
        await new Promise(resolve => setTimeout(resolve, pollMs))
        continue
      }

      // Check if sandbox is enabled
      if (row.sandbox !== 1) {
        return { ready: false, reason: 'not_sandbox_enabled' }
      }

      // Check if container name is set
      if (row.sandbox_container && row.sandbox_container.length > 0) {
        return { ready: true, containerName: row.sandbox_container }
      }

      // No container name yet - check timeout and continue polling
      if (Date.now() - startTime > timeoutMs) {
        return { ready: false, reason: 'timeout' }
      }
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }
  } catch {
    // Any error during polling - return timeout
    return { ready: false, reason: 'timeout' }
  } finally {
    try { db?.close() } catch {}
  }
}
