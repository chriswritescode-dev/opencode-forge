import { Database } from 'bun:sqlite'
import { RpcServer } from './rpc'
import { RepoMap } from './repo-map'

const dbPath = process.env['GRAPH_DB_PATH'] || ''
const cwd = process.env['GRAPH_CWD'] || '.'
const maxFilesEnv = process.env['GRAPH_MAX_FILES']
const maxFiles = maxFilesEnv && maxFilesEnv.length > 0 ? parseInt(maxFilesEnv, 10) : undefined

const rpcServer = new RpcServer()

// Handle messages from parent FIRST - before expensive initialization
self.onmessage = (event) => {
  const data = event.data
  if (data && typeof data === 'object' && 'callId' in data) {
    const msg = data as { callId: number; method: string; args: unknown[] }
    rpcServer.handle(msg, (response) => {
      postMessage(response)
    })
  }
}

// Register RPC handlers before initialization
rpcServer.register('scan', async () => {
  await repoMap.scan()
})

rpcServer.register('getStats', async () => {
  return repoMap.getStats()
})

rpcServer.register('getTopFiles', async (args: unknown[]) => {
  const limit = (args[0] as number) || 20
  return repoMap.getTopFiles(limit)
})

rpcServer.register('getFileDependents', async (args: unknown[]) => {
  const path = (args[0] as string) || ''
  return repoMap.getFileDependents(path)
})

rpcServer.register('getFileDependencies', async (args: unknown[]) => {
  const path = (args[0] as string) || ''
  return repoMap.getFileDependencies(path)
})

rpcServer.register('getFileCoChanges', async (args: unknown[]) => {
  const path = (args[0] as string) || ''
  return repoMap.getFileCoChanges(path)
})

rpcServer.register('getFileBlastRadius', async (args: unknown[]) => {
  const path = (args[0] as string) || ''
  return repoMap.getFileBlastRadius(path)
})

rpcServer.register('getFileSymbols', async (args: unknown[]) => {
  const path = (args[0] as string) || ''
  return repoMap.getFileSymbols(path)
})

rpcServer.register('findSymbols', async (args: unknown[]) => {
  const query = (args[0] as string) || ''
  const limit = (args[1] as number) || 50
  return repoMap.findSymbols(query, limit)
})

rpcServer.register('searchSymbolsFts', async (args: unknown[]) => {
  const query = (args[0] as string) || ''
  const limit = (args[1] as number) || 50
  return repoMap.searchSymbolsFts(query, limit)
})

rpcServer.register('getSymbolSignature', async (args: unknown[]) => {
  const path = (args[0] as string) || ''
  const line = (args[1] as number) || 0
  return repoMap.getSymbolSignature(path, line)
})

rpcServer.register('getCallers', async (args: unknown[]) => {
  const path = (args[0] as string) || ''
  const line = (args[1] as number) || 0
  return repoMap.getCallers(path, line)
})

rpcServer.register('getCallees', async (args: unknown[]) => {
  const path = (args[0] as string) || ''
  const line = (args[1] as number) || 0
  return repoMap.getCallees(path, line)
})

rpcServer.register('getUnusedExports', async (args: unknown[]) => {
  const limit = (args[0] as number) || 50
  return repoMap.getUnusedExports(limit)
})

rpcServer.register('getDuplicateStructures', async (args: unknown[]) => {
  const limit = (args[0] as number) || 20
  return repoMap.getDuplicateStructures(limit)
})

rpcServer.register('getNearDuplicates', async (args: unknown[]) => {
  const threshold = (args[0] as number) || 0.8
  const limit = (args[1] as number) || 50
  return repoMap.getNearDuplicates(threshold, limit)
})

rpcServer.register('getExternalPackages', async (args: unknown[]) => {
  const limit = (args[0] as number) || 50
  return repoMap.getExternalPackages(limit)
})

rpcServer.register('render', async (args: unknown[]) => {
  const opts = args[0] as { maxFiles?: number; maxSymbols?: number } | undefined
  return repoMap.render(opts)
})

rpcServer.register('onFileChanged', async (args: unknown[]) => {
  const path = (args[0] as string) || ''
  return repoMap.onFileChanged(path)
})

// Open database with WAL mode
const db = new Database(dbPath)
db.run('PRAGMA journal_mode=WAL')
db.run('PRAGMA busy_timeout=5000')
db.run('PRAGMA synchronous=NORMAL')

// Instantiate RepoMap
const repoMap = new RepoMap({ cwd, db, maxFiles })

// Initialize after handlers are registered
try {
  await repoMap.initialize()
} catch (error) {
  const errorMsg = error instanceof Error ? error.message : String(error)
  postMessage({
    callId: -1,
    error: `Worker initialization failed: ${errorMsg}`,
  })
  throw error
}
