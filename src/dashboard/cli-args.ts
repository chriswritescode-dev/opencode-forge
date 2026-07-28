import { readFlagValue } from '../utils/cli-flags'

/** Parsed `pnpm dashboard` CLI flags. Values are raw; validation happens in `resolveDashboardConfig`. */
export interface DashboardCliArgs {
  host?: string
  port?: number
  dbPath?: string
}

/**
 * Parses dashboard CLI flags from an `argv` array (skipping `argv[0]`/`argv[1]`).
 * Supports both `--flag value` and `--flag=value`. Unknown flags are ignored.
 * `--port` is returned as parsed by `Number.parseInt`, including `NaN` for
 * non-numeric input, so `resolveDashboardConfig` reports the bad flag rather
 * than dropping it silently.
 */
export function parseDashboardCliArgs(argv: string[]): DashboardCliArgs {
  const args = argv.slice(2)
  const host = readFlagValue(args, 'host')
  const port = readFlagValue(args, 'port')
  const dbPath = readFlagValue(args, 'db')
  return {
    ...(host !== undefined ? { host } : {}),
    ...(port !== undefined ? { port: Number.parseInt(port, 10) } : {}),
    ...(dbPath !== undefined ? { dbPath } : {}),
  }
}
