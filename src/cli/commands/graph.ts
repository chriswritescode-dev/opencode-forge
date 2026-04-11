import { dirname } from 'path'
import { closeDatabase, initializeDatabase, resolveDataDir } from '../../storage'
import { createGraphService } from '../../graph'
import { createKvService } from '../../services/kv'
import { createLogger } from '../../utils/logger'
import { createGraphStatusCallback } from '../../utils/graph-status-store'
import { readGraphStatus } from '../../utils/tui-graph-status'
import { confirm } from '../utils'
import { enumerateGraphCache, deleteGraphCacheDir } from '../../storage/graph-projects'

export interface GraphArgs {
  dbPath?: string
  resolvedProjectId?: string
  dir?: string
  action: 'status' | 'scan' | 'list' | 'remove'
  target?: string
  yes?: boolean
}

function printStatus(projectId: string, dbPath?: string): void {
  const status = readGraphStatus(projectId, dbPath)
  if (!status) {
    console.log('Graph Status:')
    console.log('- State: unavailable')
    return
  }

  console.log('Graph Status:')
  console.log(`- State: ${status.state}`)
  if (status.stats) {
    console.log(`- Files: ${status.stats.files}`)
    console.log(`- Symbols: ${status.stats.symbols}`)
    console.log(`- Edges: ${status.stats.edges}`)
    console.log(`- Calls: ${status.stats.calls}`)
  }
  if (status.message) {
    console.log(`- Message: ${status.message}`)
  }
}

function printList(dataDir?: string): void {
  const entries = enumerateGraphCache(dataDir)
  
  if (entries.length === 0) {
    console.log('No graph cache entries found.')
    return
  }

  console.log('Graph Cache Entries:')
  console.log('')
  
  for (const entry of entries) {
    const displayName = entry.projectName || entry.projectId || 'unknown'
    const statusLabel = entry.resolutionStatus === 'known' ? 'known' : 'unknown'
    const sizeKb = Math.round(entry.sizeBytes / 1024)
    const mtime = new Date(entry.mtimeMs).toISOString().split('T')[0]
    
    console.log(`  ${entry.hashDir}`)
    console.log(`    Project: ${displayName} (${statusLabel})`)
    console.log(`    Path: ${entry.graphDbPath}`)
    console.log(`    Size: ${sizeKb} KB`)
    console.log(`    Modified: ${mtime}`)
    console.log('')
  }
}

async function printRemove(identifier: string, dataDir?: string, requireConfirm: boolean = true): Promise<void> {
  const entries = enumerateGraphCache(dataDir)
  const targetEntry = entries.find(e => e.projectId === identifier || e.hashDir === identifier)
  
  if (!targetEntry) {
    console.error(`Graph cache entry not found: ${identifier}`)
    process.exit(1)
  }

  const displayName = targetEntry.projectName || targetEntry.projectId || targetEntry.hashDir
  const statusLabel = targetEntry.resolutionStatus === 'known' ? 'known' : 'unknown'
  
  console.log('Graph Cache Entry to Remove:')
  console.log(`  Hash: ${targetEntry.hashDir}`)
  console.log(`  Project: ${displayName} (${statusLabel})`)
  console.log(`  Path: ${targetEntry.graphDbPath}`)
  console.log('')

  if (requireConfirm) {
    const confirmed = await confirm(`Delete graph cache for ${displayName}?`)
    if (!confirmed) {
      console.log('Deletion cancelled.')
      return
    }
  }

  const success = deleteGraphCacheDir(targetEntry.hashDir, dataDir)
  
  if (success) {
    console.log('Graph cache deleted successfully.')
  } else {
    console.error('Failed to delete graph cache.')
    process.exit(1)
  }
}

export async function run(argv: GraphArgs): Promise<void> {
  const dataDir = argv.dbPath ? dirname(argv.dbPath) : resolveDataDir()

  switch (argv.action) {
    case 'status': {
      const projectId = argv.resolvedProjectId
      if (!projectId) {
        console.error('Project ID not found. Run from a git repository or pass --project.')
        process.exit(1)
      }
      printStatus(projectId, argv.dbPath)
      break
    }

    case 'scan': {
      const projectId = argv.resolvedProjectId
      if (!projectId) {
        console.error('Project ID not found. Run from a git repository or pass --project.')
        process.exit(1)
      }

      const directory = argv.dir || process.cwd()
      const logger = createLogger({ enabled: false, file: '' })
      const db = initializeDatabase(dataDir)
      const kvService = createKvService(db, logger)
      const graphService = createGraphService({
        projectId,
        dataDir,
        cwd: directory,
        logger,
        watch: false,
        onStatusChange: createGraphStatusCallback(kvService, projectId),
      })

      try {
        await graphService.scan()
        const stats = await graphService.getStats()
        console.log('Graph scan complete.')
        console.log(`- Files: ${stats.files}`)
        console.log(`- Symbols: ${stats.symbols}`)
        console.log(`- Edges: ${stats.edges}`)
        console.log(`- Calls: ${stats.calls}`)
      } finally {
        await graphService.close()
        closeDatabase(db)
      }
      break
    }

    case 'list': {
      printList(dataDir)
      break
    }

    case 'remove': {
      const identifier = argv.target
      if (!identifier) {
        console.error('Target project ID or hash directory required. Use --target or provide as argument.')
        process.exit(1)
      }
      await printRemove(identifier, dataDir, !argv.yes)
      break
    }

    default: {
      console.error(`Unknown graph action: ${argv.action}`)
      help()
      process.exit(1)
    }
  }
}

export function help(): void {
  console.log(`
Manage graph indexing

Usage:
  oc-forge graph status [options]
  oc-forge graph scan [options]
  oc-forge graph list [options]
  oc-forge graph remove <target> [options]

Actions:
  status    Show graph indexing status for current project
  scan      Trigger a graph scan for current project
  list      List all persisted graph cache entries
  remove    Remove a graph cache entry by project ID or hash

Options:
  --project, -p <id>    Project ID (auto-detected from git if not provided)
  --dir, -d <path>      Project directory for graph scanning
  --db-path <path>      Path to forge database
  --target, -t <id>     Target for removal (project ID or hash directory)
  --yes, -y             Skip confirmation prompt for removal
  --help, -h            Show this help message
  `.trim())
}

export async function cli(args: string[], globalOpts: { dbPath?: string; resolvedProjectId?: string; dir?: string }): Promise<void> {
  const action = args[0]
  if (!action || action === 'help') {
    help()
    process.exit(0)
  }

  const validActions = ['status', 'scan', 'list', 'remove']
  if (!validActions.includes(action)) {
    console.error(`Unknown graph action: ${action}`)
    help()
    process.exit(1)
  }

  if (args.includes('--help') || args.includes('-h')) {
    help()
    process.exit(0)
  }

  let target: string | undefined
  let yes = false

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--target' || args[i] === '-t') {
      target = args[++i]
    } else if (args[i] === '--yes' || args[i] === '-y') {
      yes = true
    }
  }

  if (!target && action === 'remove' && args.length > 1 && !args[0].startsWith('-')) {
    target = args[1]
  }

  await run({
    action: action as 'status' | 'scan' | 'list' | 'remove',
    dbPath: globalOpts.dbPath,
    resolvedProjectId: globalOpts.resolvedProjectId,
    dir: globalOpts.dir,
    target,
    yes,
  })
}
