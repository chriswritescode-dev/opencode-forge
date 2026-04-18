import { test, expect, beforeEach, afterEach } from 'bun:test'
import { RepoMap } from '../src/graph/repo-map'
import { Database } from 'bun:sqlite'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { initializeGraphDatabase } from '../src/graph/database'

let testDir: string
let db: Database
let repoMap: RepoMap

beforeEach(async () => {
  testDir = join('/tmp', `graph-imports-test-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
  
  // Initialize git repo
  execSync('git init', { cwd: testDir })
  execSync('git config user.email "test@test.com"', { cwd: testDir })
  execSync('git config user.name "Test"', { cwd: testDir })
  
  const dbPath = join(testDir, 'test.db')
  db = initializeGraphDatabase('test', testDir, testDir)
  repoMap = new RepoMap({ cwd: testDir, db })
  await repoMap.initialize()
})

afterEach(async () => {
  db.close()
  rmSync(testDir, { recursive: true, force: true })
})

test('import type does NOT create an edge', async () => {
  // Create two files: one exports a type, the other imports it with import type
  const fileA = join(testDir, 'types.ts')
  writeFileSync(fileA, `export type MyType = string | number`)
  
  const fileB = join(testDir, 'consumer.ts')
  writeFileSync(fileB, `import type { MyType } from './types'
export function useType(x: MyType) { return x }`)
  
  execSync('git add .', { cwd: testDir })
  
  // Index both files
  await repoMap.indexFile('types.ts')
  await repoMap.indexFile('consumer.ts')
  await repoMap.finalizeScan()
  
  // Check that no edge exists from consumer to types
  const edges = repoMap.getFileDependencies('consumer.ts')
  const typesEdge = edges.find(e => e.path === 'types.ts')
  expect(typesEdge).toBeUndefined()
})

test('dynamic import creates an edge and prevents target exports from being unused', async () => {
  // Create two files: one exports a function, the other dynamically imports it
  const fileA = join(testDir, 'module.ts')
  writeFileSync(fileA, `export function foo() { return 'foo' }`)
  
  const fileB = join(testDir, 'loader.ts')
  writeFileSync(fileB, `async function load() {
  await import('./module')
}`)
  
  execSync('git add .', { cwd: testDir })
  
  // Index both files
  await repoMap.indexFile('module.ts')
  await repoMap.indexFile('loader.ts')
  await repoMap.finalizeScan()
  
  // Check that an edge exists from loader to module
  const dependents = repoMap.getFileDependents('module.ts')
  const loaderDependent = dependents.find(d => d.path === 'loader.ts')
  expect(loaderDependent).toBeDefined()
  
  // Check that foo is NOT in unused exports
  const unused = repoMap.getUnusedExports()
  const fooUnused = unused.find(u => u.name === 'foo' && u.path === 'module.ts')
  expect(fooUnused).toBeUndefined()
})

test('package.json bin entry is not orphaned', async () => {
  // Create package.json with bin entry
  const packageJson = join(testDir, 'package.json')
  writeFileSync(packageJson, JSON.stringify({
    name: 'test-pkg',
    bin: {
      cli: './dist/cli.js'
    }
  }, null, 2))
  
  // Create the CLI file
  const cliFile = join(testDir, 'src/cli.ts')
  mkdirSync(join(testDir, 'src'), { recursive: true })
  writeFileSync(cliFile, `export function run() { console.log('cli') }`)
  
  execSync('git add .', { cwd: testDir })
  
  // Index the file
  await repoMap.indexFile('src/cli.ts')
  await repoMap.finalizeScan()
  
  // Check that src/cli.ts is NOT in orphan files
  const orphans = repoMap.getOrphanFiles()
  const cliOrphan = orphans.find(o => o.path === 'src/cli.ts')
  expect(cliOrphan).toBeUndefined()
})

test('SCC detection no longer flags type-only edges', async () => {
  // Create two files with type-only import between them
  const fileA = join(testDir, 'tools/types.ts')
  mkdirSync(join(testDir, 'tools'), { recursive: true })
  writeFileSync(fileA, `export type ToolType = 'a' | 'b'`)
  
  const fileB = join(testDir, 'hooks/loop.ts')
  mkdirSync(join(testDir, 'hooks'), { recursive: true })
  writeFileSync(fileB, `import type { ToolType } from '../tools/types'
export function loop(t: ToolType) { return t }`)
  
  execSync('git add .', { cwd: testDir })
  
  // Index both files
  await repoMap.indexFile('tools/types.ts')
  await repoMap.indexFile('hooks/loop.ts')
  await repoMap.finalizeScan()
  
  // Check that no circular dependency is detected
  const cycles = repoMap.getCircularDependencies()
  expect(cycles).toHaveLength(0)
})
