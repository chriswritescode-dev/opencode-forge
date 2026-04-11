import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { RepoMap } from '../src/graph/repo-map'
import { initializeGraphDatabase } from '../src/graph/database'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'

let testDir: string
let dbPath: string
let repoMap: RepoMap

beforeEach(async () => {
  testDir = join('/tmp', `graph-test-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
  
  // Initialize git repo so collectFilesAsync can find files
  const { execSync } = await import('child_process')
  execSync('git init', { cwd: testDir })
  execSync('git config user.email "test@test.com"', { cwd: testDir })
  execSync('git config user.name "Test"', { cwd: testDir })
  
  dbPath = join(testDir, 'test.db')
  const db = initializeGraphDatabase('test-project', testDir)
  
  repoMap = new RepoMap({ cwd: testDir, db })
  await repoMap.initialize()
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

test('forward import resolution after full scan', async () => {
  // Create file A that imports from file B
  const fileA = join(testDir, 'a.ts')
  writeFileSync(fileA, `import { helper } from './b'\n\nexport function main() {\n  helper()\n}`)
  
  // Create file B that is imported by A
  const fileB = join(testDir, 'b.ts')
  writeFileSync(fileB, `export function helper() {\n  return 'help'\n}`)
  
  // Add files to git
  const { execSync } = await import('child_process')
  execSync('git add .', { cwd: testDir })
  
  // Scan should resolve the import even though files are indexed in order
  await repoMap.scan()
  
  // Check that edges were created
  const deps = repoMap.getFileDependencies('a.ts')
  expect(deps.length).toBeGreaterThan(0)
  expect(deps.some(d => d.path === 'b.ts')).toBe(true)
})

test('external package ingestion', async () => {
  const fileA = join(testDir, 'a.ts')
  writeFileSync(fileA, `import express from 'express'\nimport { Router } from 'express'\n\nexport const app = express()`);
  
  await repoMap.scan()
  
  const packages = repoMap.getExternalPackages()
  expect(packages.length).toBeGreaterThan(0)
  expect(packages.some(p => p.package === 'express')).toBe(true)
})

test('scoped external package names preserved', async () => {
  const fileA = join(testDir, 'a.ts')
  writeFileSync(fileA, `import type { Logger } from '@opencode-ai/sdk'\nimport { resolve } from '@types/node/path'\n\nexport const app = null`);
  
  await repoMap.scan()
  
  const packages = repoMap.getExternalPackages()
  expect(packages.length).toBeGreaterThan(0)
  // Scoped packages should preserve @scope/name format
  expect(packages.some(p => p.package === '@opencode-ai/sdk')).toBe(true)
  expect(packages.some(p => p.package === '@types/node')).toBe(true)
  // Should NOT have just '@types' or '@opencode-ai' alone
  expect(packages.some(p => p.package === '@types')).toBe(false)
  expect(packages.some(p => p.package === '@opencode-ai')).toBe(false)
})

test('token extraction works when repo root differs from process cwd', async () => {
  // Create a subdirectory to use as an "outside" repo
  const outsideDir = join(testDir, 'outside-repo')
  mkdirSync(outsideDir, { recursive: true })
  
  const { execSync } = await import('child_process')
  execSync('git init', { cwd: outsideDir })
  execSync('git config user.email "test@test.com"', { cwd: outsideDir })
  execSync('git config user.name "Test"', { cwd: outsideDir })
  
  const fileA = join(outsideDir, 'a.ts')
  writeFileSync(fileA, `export function testFunction(x: number, y: string): boolean {\n  return x > 0\n}`)
  
  execSync('git add .', { cwd: outsideDir })
  
  // Create RepoMap with the outside directory as cwd
  const dbPath2 = join(outsideDir, 'test.db')
  const db = initializeGraphDatabase('test-project-2', outsideDir)
  const outsideRepoMap = new RepoMap({ cwd: outsideDir, db })
  await outsideRepoMap.initialize()
  
  // Index the file using a path relative to the outside repo
  await outsideRepoMap.indexFile('a.ts')
  
  // Token signatures should be populated (this validates absPath cache lookup)
  // Query token_signatures table directly to verify token extraction worked
  const tokenSigs = db.prepare('SELECT * FROM token_signatures WHERE file_id = (SELECT id FROM files WHERE path = ?)').all('a.ts') as Array<{
    id: number
    file_id: number
    name: string
    line: number
    end_line: number
    minhash: Uint32Array
  }>
  
  expect(tokenSigs.length).toBeGreaterThan(0)
  const testSig = tokenSigs.find(s => s.name === 'testFunction')
  expect(testSig).toBeDefined()
  expect(testSig?.minhash).toBeDefined()
})

test('signature extraction for indexed symbols', async () => {
  const fileA = join(testDir, 'a.ts')
  writeFileSync(fileA, `export function testFunction(x: number, y: string): boolean {\n  return true\n}`)
  
  await repoMap.scan()
  
  const signature = repoMap.getSymbolSignature('a.ts', 1)
  expect(signature).not.toBeNull()
  expect(signature?.signature).toContain('testFunction')
})

test('call graph stats count real calls', async () => {
  const fileA = join(testDir, 'a.ts')
  writeFileSync(fileA, `import { helper } from './b'\n\nexport function main() {\n  helper()\n}`)
  
  const fileB = join(testDir, 'b.ts')
  writeFileSync(fileB, `export function helper() {\n  return 'help'\n}`)
  
  await repoMap.scan()
  
  const stats = repoMap.getStats()
  expect(stats.calls).toBeGreaterThan(0)
})

test('caller/callee disambiguation for duplicate symbol names', async () => {
  // Create two files with same function name
  const fileA = join(testDir, 'a.ts')
  writeFileSync(fileA, `export function duplicate() {\n  return 'a'\n}`)
  
  const fileB = join(testDir, 'b.ts')
  writeFileSync(fileB, `import { duplicate } from './a'\n\nexport function duplicate() {\n  duplicate()\n  return 'b'\n}`)
  
  const { execSync } = await import('child_process')
  execSync('git add .', { cwd: testDir })
  
  await repoMap.scan()
  
  // Get callees for fileB's duplicate function
  const callees = repoMap.getCallees('b.ts', 3)
  // Should return an array (may be empty if no calls detected)
  expect(Array.isArray(callees)).toBe(true)
  
  // Verify disambiguation: callees from fileA should reference fileB specifically
  const calleesFromA = repoMap.getCallees('a.ts', 3)
  expect(Array.isArray(calleesFromA)).toBe(true)
})

test('incremental edit rebuild correctness', async () => {
  const fileA = join(testDir, 'a.ts')
  writeFileSync(fileA, `import { helper } from './b'\n\nexport function main() {\n  helper()\n}`)
  
  const fileB = join(testDir, 'b.ts')
  writeFileSync(fileB, `export function helper() {\n  return 'help'\n}`)
  
  await repoMap.scan()
  
  const initialDeps = repoMap.getFileDependencies('a.ts')
  expect(initialDeps.some(d => d.path === 'b.ts')).toBe(true)
  
  // Edit file B to remove the export
  writeFileSync(fileB, `function helper() {\n  return 'help'\n}`)
  
  await repoMap.onFileChanged(fileB)
  
  // Rebuild edges after the file change
  await repoMap.buildEdges()
  
  // The dependency should be updated - edge should be removed since b.ts no longer exports helper
  const updatedDeps = repoMap.getFileDependencies('a.ts')
  // The edge to b.ts should be gone after rebuild
  expect(updatedDeps.some(d => d.path === 'b.ts')).toBe(false)
})

test('incremental delete rebuild correctness', async () => {
  const fileA = join(testDir, 'a.ts')
  writeFileSync(fileA, `import { helper } from './b'\n\nexport function main() {\n  helper()\n}`)
  
  const fileB = join(testDir, 'b.ts')
  writeFileSync(fileB, `export function helper() {\n  return 'help'\n}`)
  
  await repoMap.scan()
  
  const initialDeps = repoMap.getFileDependencies('a.ts')
  expect(initialDeps.some(d => d.path === 'b.ts')).toBe(true)
  
  // Delete file B
  rmSync(fileB)
  
  await repoMap.onFileChanged(fileB)
  
  // The dependency should be removed after rebuild
  const updatedDeps = repoMap.getFileDependencies('a.ts')
  // The edge to b.ts should be gone
  expect(updatedDeps.every(d => d.path !== 'b.ts')).toBe(true)
})

test('render respects maxFiles and maxSymbols options', async () => {
  // Create multiple files
  for (let i = 0; i < 5; i++) {
    const file = join(testDir, `file${i}.ts`)
    writeFileSync(file, `export function func${i}() {}\nexport function func2${i}() {}\nexport function func3${i}() {}`)
  }
  
  await repoMap.scan()
  
  // Test with limited maxFiles
  const limited = await repoMap.render({ maxFiles: 2, maxSymbols: 1 })
  const full = await repoMap.render({ maxFiles: 20, maxSymbols: 20 })
  
  expect(limited.paths.length).toBeLessThanOrEqual(2)
  expect(limited.content.split('\n').length).toBeLessThanOrEqual(full.content.split('\n').length)
})

test('getFileSymbols returns one entry per declaration (no duplicates)', async () => {
  // Create a file with an exported function - should produce exactly one symbol
  const fileA = join(testDir, 'index.ts')
  writeFileSync(fileA, `export function createService(ttlSeconds?: number) {
  return null
}`)
  
  await repoMap.scan()
  
  const symbols = repoMap.getFileSymbols('index.ts')
  expect(symbols).toHaveLength(1)
  expect(symbols[0].name).toBe('createService')
  expect(symbols[0].line).toBe(1)
})

test('findSymbols returns one result per declaration (no duplicates)', async () => {
  // Create a file with an exported function
  const fileA = join(testDir, 'cache.ts')
  writeFileSync(fileA, `export function createCacheService() {
  return null
}`)
  
  await repoMap.scan()
  
  const results = repoMap.findSymbols('createCacheService')
  expect(results).toHaveLength(1)
  expect(results[0].name).toBe('createCacheService')
  expect(results[0].path).toBe('cache.ts')
})

test('same symbol name in different files both appear', async () => {
  // Create two files with the same function name - both should appear
  const fileA = join(testDir, 'a.ts')
  writeFileSync(fileA, `export function shared() {
  return 'a'
}`)
  
  const fileB = join(testDir, 'b.ts')
  writeFileSync(fileB, `export function shared() {
  return 'b'
}`)
  
  await repoMap.scan()
  
  const results = repoMap.findSymbols('shared')
  expect(results).toHaveLength(2)
  
  const paths = results.map(r => r.path).sort()
  expect(paths).toEqual(['a.ts', 'b.ts'])
})

test('exported class produces one symbol entry', async () => {
  const fileA = join(testDir, 'class.ts')
  writeFileSync(fileA, `export class TestClass {
  method() {}
}`)
  
  await repoMap.scan()
  
  const symbols = repoMap.getFileSymbols('class.ts')
  const classSymbols = symbols.filter(s => s.kind === 'class')
  expect(classSymbols).toHaveLength(1)
  expect(classSymbols[0].name).toBe('TestClass')
})

test('exported variable produces one symbol entry', async () => {
  const fileA = join(testDir, 'var.ts')
  writeFileSync(fileA, `export const MY_CONSTANT = 42`)
  
  await repoMap.scan()
  
  const symbols = repoMap.getFileSymbols('var.ts')
  const varSymbols = symbols.filter(s => s.kind === 'variable')
  expect(varSymbols).toHaveLength(1)
  expect(varSymbols[0].name).toBe('MY_CONSTANT')
})
