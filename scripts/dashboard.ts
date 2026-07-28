#!/usr/bin/env bun
import { parseDashboardCliArgs } from '../src/dashboard/cli-args'
import { describeDashboardBinding } from '../src/dashboard/config'
import { startDashboardServer } from '../src/dashboard/launch'
import { loadPluginConfig } from '../src/setup'

function main(): void {
  const args = parseDashboardCliArgs(process.argv)
  const config = loadPluginConfig()

  try {
    const handle = startDashboardServer({
      host: args.host,
      port: args.port,
      dbPath: args.dbPath,
      config,
    })
    for (const warning of handle.warnings) console.warn(warning)
    const notice = describeDashboardBinding(handle)
    console.log(`Forge dashboard running: ${notice.url}`)
    if (notice.localUrl) console.log(`Local: ${notice.localUrl}`)
    if (notice.warning) console.warn(notice.warning)
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
