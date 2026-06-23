#!/usr/bin/env bun
import { startDashboardServer } from '../src/dashboard/launch'
import { createEventBroadcaster } from '../src/dashboard/event-broadcaster'
import { createDashboardEventClient, startActivityForwarding } from '../src/dashboard/opencode-events'
import type { DashboardEventSource } from '../src/types'

interface Args {
  port?: number
  dbPath?: string
  serverUrl?: string
  eventsSource?: DashboardEventSource
}

function parseEventsSource(value: string): DashboardEventSource | undefined {
  return value === 'server' || value === 'tui' || value === 'none' ? value : undefined
}

function parseArgs(argv: string[]): Args {
  const args: Args = {}

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--port' && i + 1 < argv.length) {
      args.port = Number.parseInt(argv[++i], 10)
    } else if (arg === '--db' && i + 1 < argv.length) {
      args.dbPath = argv[++i]
    } else if (arg === '--server-url' && i + 1 < argv.length) {
      args.serverUrl = argv[++i]
    } else if (arg === '--events-source' && i + 1 < argv.length) {
      args.eventsSource = parseEventsSource(argv[++i])
    } else if (arg.startsWith('--port=')) {
      args.port = Number.parseInt(arg.split('=')[1], 10)
    } else if (arg.startsWith('--db=')) {
      args.dbPath = arg.split('=')[1]
    } else if (arg.startsWith('--server-url=')) {
      args.serverUrl = arg.split('=')[1]
    } else if (arg.startsWith('--events-source=')) {
      args.eventsSource = parseEventsSource(arg.split('=')[1])
    }
  }

  return args
}

function main(): void {
  const args = parseArgs(process.argv)

  // A live feed standalone requires a reachable server (no in-process client
  // or TUI bus). Wire it only when a serverUrl is supplied and the source is
  // not disabled; otherwise the SSE endpoint reports no feed (204).
  const source: DashboardEventSource = args.eventsSource ?? 'server'
  const wantsFeed = source !== 'none' && Boolean(args.serverUrl)

  const broadcaster = wantsFeed ? createEventBroadcaster() : null
  let detachEvents: (() => void) | null = null

  if (broadcaster && args.serverUrl) {
    const client = createDashboardEventClient({ configuredServerUrl: args.serverUrl })
    detachEvents = startActivityForwarding(
      { source },
      {
        publish: broadcaster.publish,
        client,
        onError: (err) =>
          console.warn(`[forge] activity feed error: ${err instanceof Error ? err.message : String(err)}`),
      },
    )
  }

  try {
    const handle = startDashboardServer({ port: args.port, dbPath: args.dbPath, events: broadcaster })
    console.log(`Forge dashboard running: ${handle.url}`)
    if (broadcaster) {
      const shutdown = () => {
        detachEvents?.()
        broadcaster.close()
        handle.stop()
        process.exit(0)
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
    }
  } catch (err) {
    detachEvents?.()
    broadcaster?.close()
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

main()
