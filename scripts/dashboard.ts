#!/usr/bin/env bun
import { startDashboardServer } from '../src/dashboard/launch'

interface Args {
  port?: number
  dbPath?: string
}

function parseArgs(argv: string[]): Args {
  const args: Args = {}

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--port' && i + 1 < argv.length) {
      args.port = Number.parseInt(argv[++i], 10)
    } else if (arg === '--db' && i + 1 < argv.length) {
      args.dbPath = argv[++i]
    } else if (arg.startsWith('--port=')) {
      args.port = Number.parseInt(arg.split('=')[1], 10)
    } else if (arg.startsWith('--db=')) {
      args.dbPath = arg.split('=')[1]
    }
  }

  return args
}

function main(): void {
  const args = parseArgs(process.argv)

  try {
    const handle = startDashboardServer({ port: args.port, dbPath: args.dbPath })
    console.log(`Forge dashboard running: ${handle.url}`)
    const shutdown = () => {
      handle.stop()
      process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

main()
