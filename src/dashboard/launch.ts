import { existsSync } from 'fs'
import { platform } from 'os'
import { resolveForgeDbPath, openForgeDatabaseReadonly } from '../storage/database'
import { createRequestHandler } from './server'

export interface DashboardServerHandle {
  url: string
  port: number
  stop: () => void
}

export interface StartDashboardOptions {
  port?: number
  dbPath?: string
  maxAttempts?: number
}

const DEFAULT_PORT = 4747
const DEFAULT_MAX_ATTEMPTS = 10

export function resolveDashboardDbPath(explicit?: string): string {
  if (explicit) return explicit
  if (process.env.FORGE_DB) return process.env.FORGE_DB
  return resolveForgeDbPath()
}

function isAddrInUse(err: unknown): boolean {
  return Boolean(
    err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'EADDRINUSE'
  )
}

/**
 * Opens the forge database read-only and starts a Bun HTTP server that serves
 * the dashboard. Retries on consecutive ports when the requested port is busy.
 * The returned handle owns both the server and the database connection; calling
 * `stop` releases both.
 */
export function startDashboardServer(options: StartDashboardOptions = {}): DashboardServerHandle {
  const dbPath = resolveDashboardDbPath(options.dbPath)
  if (!existsSync(dbPath)) {
    throw new Error(
      `Forge database not found at ${dbPath}. Run a loop first or pass a database path.`
    )
  }

  const basePort = options.port ?? DEFAULT_PORT
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const db = openForgeDatabaseReadonly(dbPath)
  const handler = createRequestHandler(db)

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const port = basePort + attempt
    try {
      const server = Bun.serve({ hostname: 'localhost', port, fetch: handler })
      const boundPort = server.port ?? port
      return {
        url: `http://localhost:${boundPort}`,
        port: boundPort,
        stop: () => {
          server.stop()
          db.close()
        },
      }
    } catch (err) {
      if (!isAddrInUse(err) || attempt === maxAttempts - 1) {
        db.close()
        throw new Error(
          `Failed to start dashboard on port ${port}. ` +
          `Port ${port} is in use or another error occurred. ` +
          `Try a different port.`,
          { cause: err }
        )
      }
    }
  }

  db.close()
  throw new Error('Failed to start dashboard: exhausted port attempts.')
}

/**
 * Opens the given URL in the platform's default browser. Returns false when the
 * launch could not be initiated.
 */
export function openInBrowser(url: string): boolean {
  const command =
    platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'cmd' : 'xdg-open'
  const args = platform() === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    Bun.spawn([command, ...args], { stdout: 'ignore', stderr: 'ignore' })
    return true
  } catch {
    return false
  }
}
