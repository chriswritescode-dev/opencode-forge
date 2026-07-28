#!/usr/bin/env bun
import { parseDashboardCliArgs } from '../src/dashboard/cli-args'
import { describeDashboardBinding, isValidDashboardPort } from '../src/dashboard/config'
import { startDashboardServer } from '../src/dashboard/launch'
import { loadPluginConfig } from '../src/setup'

function main(): void {
  const args = parseDashboardCliArgs(process.argv)

  if (args.port !== undefined && !isValidDashboardPort(args.port)) {
    console.warn('Ignoring invalid --port value; expected an integer between 0 and 65535.')
  }

  const config = loadPluginConfig()

  try {
    const handle = startDashboardServer({
      host: args.host,
      port: args.port,
      dbPath: args.dbPath,
      dataDir: config.dataDir,
      config,
    })
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
