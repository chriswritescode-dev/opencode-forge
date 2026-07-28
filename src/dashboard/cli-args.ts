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
 * non-numeric input, so the caller can report the bad flag before
 * `resolveDashboardConfig` discards it.
 */
export function parseDashboardCliArgs(argv: string[]): DashboardCliArgs {
  const args: DashboardCliArgs = {}

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--host' && i + 1 < argv.length) {
      args.host = argv[++i]
    } else if (arg === '--port' && i + 1 < argv.length) {
      args.port = Number.parseInt(argv[++i], 10)
    } else if (arg === '--db' && i + 1 < argv.length) {
      args.dbPath = argv[++i]
    } else if (arg.startsWith('--host=')) {
      args.host = arg.slice('--host='.length)
    } else if (arg.startsWith('--port=')) {
      args.port = Number.parseInt(arg.slice('--port='.length), 10)
    } else if (arg.startsWith('--db=')) {
      args.dbPath = arg.slice('--db='.length)
    }
  }

  return args
}
