import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

function createTestKvDb(tempDir: string): Database {
  const dbPath = join(tempDir, 'graph.db')
  const db = new Database(dbPath)

  db.run(`
    CREATE TABLE IF NOT EXISTS project_kv (
      project_id TEXT NOT NULL,
      key TEXT NOT NULL,
      data TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, key)
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
    tempDir = mkdtempSync(join('.', 'temp-graph-cli-'))
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
    const db = createTestKvDb(tempDir)
    db.run(
      'INSERT INTO project_kv (project_id, key, data, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [
        'test-project',
        'graph:status',
        JSON.stringify({ state: 'ready', stats: { files: 3, symbols: 10, edges: 5, calls: 2 }, updatedAt: Date.now() }),
        Date.now() + 86400000,
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
})
