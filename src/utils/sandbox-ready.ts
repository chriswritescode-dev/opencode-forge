import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { z } from 'zod'
import { MSB_DEFAULT_TIMEOUT } from '../sandbox/msb'

const sandboxLoopRowSchema = z.object({
  sandbox: z.number(),
  sandbox_container: z.string().nullable(),
})

export interface WaitForSandboxOptions {
  projectId: string
  loopName: string
  dbPath: string
  pollMs?: number
  timeoutMs?: number
}

export type WaitForSandboxResult =
  | { ready: true; containerName: string }
  | { ready: false; reason: 'timeout' | 'state_missing' | 'not_sandbox_enabled' | 'db_missing' | 'error'; error?: string }

export async function waitForSandboxReady(opts: WaitForSandboxOptions): Promise<WaitForSandboxResult> {
  const { projectId, loopName, dbPath } = opts
  const pollMs = opts.pollMs ?? 200
  const timeoutMs = opts.timeoutMs ?? MSB_DEFAULT_TIMEOUT
  const startTime = Date.now()

  if (!existsSync(dbPath)) {
    return { ready: false, reason: 'db_missing' }
  }

  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    db.run('PRAGMA busy_timeout=5000')

    while (true) {
      const raw = db.prepare(
        'SELECT sandbox, sandbox_container FROM loops WHERE project_id = ? AND loop_name = ?'
      ).get(projectId, loopName)

      if (!raw) {
        if (Date.now() - startTime > timeoutMs) {
          return { ready: false, reason: 'timeout' }
        }
        await new Promise(resolve => setTimeout(resolve, pollMs))
        continue
      }

      const row = sandboxLoopRowSchema.parse(raw)

      if (row.sandbox !== 1) {
        return { ready: false, reason: 'not_sandbox_enabled' }
      }

      if (row.sandbox_container && row.sandbox_container.length > 0) {
        return { ready: true, containerName: row.sandbox_container }
      }

      if (Date.now() - startTime > timeoutMs) {
        return { ready: false, reason: 'timeout' }
      }
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }
  } catch (err) {
    return { ready: false, reason: 'error', error: err instanceof Error ? err.message : String(err) }
  } finally {
    try { db?.close() } catch {}
  }
}
