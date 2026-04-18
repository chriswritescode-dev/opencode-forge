import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { hashGraphCacheScope } from '../src/storage/graph-projects'

function createTestGraphStatusDb(tempDir: string): Database {
  const dbPath = join(tempDir, 'graph.db')
  const db = new Database(dbPath)

  db.run(`
    CREATE TABLE IF NOT EXISTS graph_status (
      project_id   TEXT NOT NULL,
      cwd          TEXT NOT NULL DEFAULT '',
      state        TEXT NOT NULL,
      ready        INTEGER NOT NULL,
      stats_json   TEXT,
      message      TEXT,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (project_id, cwd)
    )
  `)

  return db
}

describe('CLI Graph', () => {
  let tempDir: string
  let projectDir: string
  let originalLog: typeof console.log
  let originalError: typeof console.error

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'temp-graph-cli-'))
    projectDir = join(tempDir, 'project')
    mkdirSync(projectDir, { recursive: true })
    originalLog = console.log
    originalError = console.error
  })

  afterEach(() => {
    console.log = originalLog
    console.error = originalError
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('status prints persisted graph status', async () => {
    const db = createTestGraphStatusDb(tempDir)
    const stats = { files: 3, symbols: 10, edges: 5, calls: 2 }
    db.run(
      'INSERT INTO graph_status (project_id, cwd, state, ready, stats_json, message, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        'test-project',
        '',
        'ready',
        1,
        JSON.stringify(stats),
        null,
        Date.now(),
      ]
    )
    db.close()

    const outputLines: string[] = []
    console.log = (msg?: unknown) => outputLines.push(String(msg ?? ''))

    const { run } = await import('../src/cli/commands/graph')
    await run({
      action: 'status',
      dbPath: join(tempDir, 'graph.db'),
      resolvedProjectId: 'test-project',
      dir: projectDir,
    })

    const output = outputLines.join('\n')
    expect(output).toContain('Graph Status:')
    expect(output).toContain('State: ready')
    expect(output).toContain('Files: 3')
  })

  test('scan runs graph indexing for the provided directory', async () => {
    writeFileSync(join(projectDir, 'index.ts'), 'export function greet(name: string) { return `hi ${name}` }')

    const outputLines: string[] = []
    console.log = (msg?: unknown) => outputLines.push(String(msg ?? ''))

    const { run } = await import('../src/cli/commands/graph')
    await run({
      action: 'scan',
      dbPath: join(tempDir, 'graph.db'),
      resolvedProjectId: 'test-project',
      dir: projectDir,
    })

    const output = outputLines.join('\n')
    expect(output).toContain('Graph scan complete.')
    expect(output).toContain('Files:')
  })

  test('scan should succeed even when shared database is corrupted', async () => {
    const dbPath = join(tempDir, 'graph.db')
    
    // Create and corrupt the database
    const db = new Database(dbPath)
    db.close()
    writeFileSync(dbPath, 'CORRUPTED DATA')

    writeFileSync(join(projectDir, 'index.ts'), 'export const x = 1')

    const outputLines: string[] = []
    console.log = (msg?: unknown) => outputLines.push(String(msg ?? ''))

    const { run } = await import('../src/cli/commands/graph')
    await run({
      action: 'scan',
      dbPath: dbPath,
      resolvedProjectId: 'test-project',
      dir: projectDir,
    })

    const output = outputLines.join('\n')
    expect(output).toContain('Graph scan complete.')
  })

  test('scan should succeed when graph cache DB is corrupted', async () => {
    const projectId = 'test-project-' + Date.now()
    const cacheHash = hashGraphCacheScope(projectId, projectDir)
    const graphCacheDir = join(tempDir, 'graph', cacheHash)
    const graphCacheDbPath = join(graphCacheDir, 'graph.db')
    
    // Create the graph cache directory structure
    mkdirSync(graphCacheDir, { recursive: true })
    
    // Create and immediately corrupt the graph cache database
    const graphDb = new Database(graphCacheDbPath)
    graphDb.close()
    writeFileSync(graphCacheDbPath, 'CORRUPTED GRAPH DATA THAT IS MALFORMED')

    writeFileSync(join(projectDir, 'index.ts'), 'export const y = 2')

    const outputLines: string[] = []
    console.log = (msg?: unknown) => outputLines.push(String(msg ?? ''))

    const { run } = await import('../src/cli/commands/graph')
    await run({
      action: 'scan',
      dbPath: join(tempDir, 'graph.db'),
      resolvedProjectId: projectId,
      dir: projectDir,
    })

    const output = outputLines.join('\n')
    expect(output).toContain('Graph scan complete.')
    expect(output).toContain('Files:')
  })
})
