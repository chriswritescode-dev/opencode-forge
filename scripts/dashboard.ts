#!/usr/bin/env bun
import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { join } from 'path'
import { resolveDataDir } from '../src/storage/database'
import { createRequestHandler } from '../src/dashboard/server'

interface Args {
  port: number
  dbPath: string
}

function parseArgs(argv: string[]): Args {
  let port = 4747
  let dbPath = join(resolveDataDir(), 'forge.db')

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--port' && i + 1 < argv.length) {
      port = Number.parseInt(argv[++i], 10)
    } else if (arg === '--db' && i + 1 < argv.length) {
      dbPath = argv[++i]
    } else if (arg.startsWith('--port=')) {
      port = Number.parseInt(arg.split('=')[1], 10)
    } else if (arg.startsWith('--db=')) {
      dbPath = arg.split('=')[1]
    }
  }

  return { port, dbPath }
}

function main(): void {
  const args = parseArgs(process.argv)

  // Respect FORGE_DB env var as default when --db is absent
  if (process.env.FORGE_DB && !process.argv.some(a => a.startsWith('--db'))) {
    args.dbPath = process.env.FORGE_DB
  }

  if (!existsSync(args.dbPath)) {
    console.error(
      `Forge database not found at ${args.dbPath}. Run a loop first or pass --db <path>.`
    )
    process.exit(1)
  }

  const db = new Database(args.dbPath, { readonly: true })
  const handler = createRequestHandler(db)

  const maxAttempts = 10
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const server = Bun.serve({ port: args.port + attempt, fetch: handler })
      console.log(`Forge dashboard running: http://localhost:${server.port}`)
      return
    } catch (err) {
      const isEaddrinuse =
        err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'EADDRINUSE'
      if (!isEaddrinuse || attempt === maxAttempts - 1) {
        console.error(
          `Failed to start dashboard on port ${args.port + attempt}. ` +
          `Port ${args.port + attempt} is in use or another error occurred. ` +
          `Try a different port with --port <n>.`
        )
        process.exit(1)
      }
    }
  }
}

main()
