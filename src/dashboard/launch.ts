import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { platform } from 'os'
import { resolveForgeDbPath } from '../storage/database'
import type { PluginConfig } from '../types'
import { buildDashboardUrls, resolveDashboardConfig, type DashboardUrls } from './config'
import { createRequestHandler } from './server'

export interface DashboardServerHandle extends DashboardUrls {
  /** The host actually passed to `Bun.serve`. */
  host: string
  port: number
  /** Bind values that were present but unusable; surfaces render these verbatim. */
  warnings: string[]
  stop: () => void
}

export interface StartDashboardOptions {
  /** Explicit bind host override (e.g. a CLI flag). Wins over `config.dashboard.host`. */
  host?: string
  /** Explicit base port override (e.g. a CLI flag). Wins over `config.dashboard.port`. */
  port?: number
  dbPath?: string
  /** Overrides `config.dataDir` when no explicit `dbPath`/`FORGE_DB` is given. */
  dataDir?: string
  maxAttempts?: number
  /** Loaded plugin config; supplies `dataDir` and `dashboard.host`/`dashboard.port`. */
  config?: PluginConfig
}

const DEFAULT_MAX_ATTEMPTS = 10

export function resolveDashboardDbPath(explicit?: string, configuredDataDir?: string): string {
  if (explicit) return explicit
  if (process.env.FORGE_DB) return process.env.FORGE_DB
  return resolveForgeDbPath(configuredDataDir)
}

function isAddrInUse(err: unknown): boolean {
  return Boolean(
    err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'EADDRINUSE'
  )
}

/**
 * Opens the forge database read-only and starts a Bun HTTP server that serves
 * the dashboard. The bind host comes from `resolveDashboardConfig` (precedence:
 * explicit options > `dashboard.*` config > built-in default). Consecutive ports
 * are still tried on `EADDRINUSE` regardless of whether the port was explicitly
 * configured. The returned handle owns both the server and the database
 * connection; calling `stop` releases both.
 */
export function startDashboardServer(options: StartDashboardOptions = {}): DashboardServerHandle {
  const dbPath = resolveDashboardDbPath(options.dbPath, options.dataDir ?? options.config?.dataDir)
  if (!existsSync(dbPath)) {
    throw new Error(
      `Forge database not found at ${dbPath}. Run a loop first or pass a database path.`
    )
  }

  const { host, port: basePort, warnings } = resolveDashboardConfig(options.config, {
    host: options.host,
    port: options.port,
  })
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const db = new Database(dbPath, { readonly: true })
  db.run('PRAGMA busy_timeout=5000')
  const handler = createRequestHandler({ forgeDb: db })

  function closeAll(): void {
    db.close()
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const port = basePort + attempt
    try {
      // idleTimeout: 0 disables Bun's per-request idle timeout (default 10s).
      const server = Bun.serve({ hostname: host, port, idleTimeout: 0, fetch: handler })
      const boundPort = server.port ?? port
      return {
        ...buildDashboardUrls(host, boundPort),
        host,
        port: boundPort,
        warnings,
        stop: () => {
          server.stop()
          closeAll()
        },
      }
    } catch (err) {
      if (!isAddrInUse(err) || attempt === maxAttempts - 1) {
        closeAll()
        throw new Error(
          `Failed to start dashboard on ${host}:${port}. ` +
          `The address is in use, unavailable on this machine, or another error occurred. ` +
          `Try a different host or port.`,
          { cause: err }
        )
      }
    }
  }

  closeAll()
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
