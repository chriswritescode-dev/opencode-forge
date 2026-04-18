import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { RepoMap } from '../src/graph/repo-map'
import { initializeGraphDatabase } from '../src/graph/database'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'

let testDir: string
let repoMap: RepoMap

beforeEach(async () => {
  testDir = join('/tmp', `graph-unused-exports-test-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
  
  // Initialize git repo so collectFilesAsync can find files
  const { execSync } = await import('child_process')
  execSync('git init', { cwd: testDir })
  execSync('git config user.email "test@test.com"', { cwd: testDir })
  execSync('git config user.name "Test"', { cwd: testDir })
  
  const db = initializeGraphDatabase('test-project', testDir)
  
  repoMap = new RepoMap({ cwd: testDir, db })
  await repoMap.initialize()
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

test('same-file-only used export is NOT reported as unused', async () => {
  // Create a file that exports a constant and uses it only within the same file
  const fileA = join(testDir, 'self-used.ts')
  writeFileSync(fileA, `export const CONST_A = 42\n\nexport function compute() {\n  return CONST_A * 2\n}`)
  
  const { execSync } = await import('child_process')
  execSync('git add .', { cwd: testDir })
  
  await repoMap.scan()
  
  const unused = repoMap.getUnusedExports()
  // CONST_A is used within the same file, so it should NOT be in unused exports
  expect(unused.some(u => u.name === 'CONST_A')).toBe(false)
})

test('truly unused export IS reported as unused', async () => {
  // Create a file that exports a function with zero references anywhere
  const fileA = join(testDir, 'truly-dead.ts')
  writeFileSync(fileA, `export function deadFn() {\n  return 'nobody calls me'\n}`)
  
  const { execSync } = await import('child_process')
  execSync('git add .', { cwd: testDir })
  
  await repoMap.scan()
  
  const unused = repoMap.getUnusedExports()
  // deadFn has no references, so it SHOULD be in unused exports
  expect(unused.some(u => u.name === 'deadFn')).toBe(true)
})

test.skip('barrel re-export is NOT reported as unused', async () => {
  // SKIP: Re-exports aren't currently captured as symbols by tree-sitter
  // This test would require extending tree-sitter query handling for re-exports
  const leafFile = join(testDir, 'leaf.ts')
  writeFileSync(leafFile, `export type LeafType = string`)
  
  const indexFile = join(testDir, 'index.ts')
  writeFileSync(indexFile, `export { LeafType } from './leaf'`)
  
  const consumerFile = join(testDir, 'consumer.ts')
  writeFileSync(consumerFile, `import { LeafType } from './index'\n\nexport const x: LeafType = 'test'`)
  
  const { execSync } = await import('child_process')
  execSync('git add .', { cwd: testDir })
  
  await repoMap.scan()
  
  const unused = repoMap.getUnusedExports()
  // LeafType is re-exported through barrel and used, so NOT unused
  expect(unused.some(u => u.name === 'LeafType')).toBe(false)
})

test('cross-file used export is NOT reported as unused', async () => {
  // Create a file that exports a function
  const fileA = join(testDir, 'exporter.ts')
  writeFileSync(fileA, `export function usedFn() {\n  return 'i am used'\n}`)
  
  // Create another file that imports and uses it
  const fileB = join(testDir, 'importer.ts')
  writeFileSync(fileB, `import { usedFn } from './exporter'\n\nexport const result = usedFn()`)
  
  const { execSync } = await import('child_process')
  execSync('git add .', { cwd: testDir })
  
  await repoMap.scan()
  
  const unused = repoMap.getUnusedExports()
  
  // usedFn is imported by another file, so NOT unused
  expect(unused.some(u => u.name === 'usedFn')).toBe(false)
})

test('usedInternally field is correctly populated', async () => {
  // Create a file with both internal-only and truly unused exports
  const fileA = join(testDir, 'mixed.ts')
  writeFileSync(fileA, `
    export const INTERNAL_ONLY = 100
    export const TRULY_UNUSED = 200
    
    export function useInternal() {
      return INTERNAL_ONLY * 2
    }
  `)
  
  const { execSync } = await import('child_process')
  execSync('git add .', { cwd: testDir })
  
  await repoMap.scan()
  
  const unused = repoMap.getUnusedExports()
  
  // TRULY_UNUSED should be in the list
  const trulyUnused = unused.find(u => u.name === 'TRULY_UNUSED')
  expect(trulyUnused).toBeDefined()
  expect(trulyUnused?.usedInternally).toBe(false)
  
  // INTERNAL_ONLY should NOT be in the default list (filtered out)
  const internalOnly = unused.find(u => u.name === 'INTERNAL_ONLY')
  expect(internalOnly).toBeUndefined()
  
  // But when includeInternalOnly is true, INTERNAL_ONLY should appear
  const allUnused = repoMap.getUnusedExports(50, true)
  const internalOnlyInAll = allUnused.find(u => u.name === 'INTERNAL_ONLY')
  expect(internalOnlyInAll).toBeDefined()
  expect(internalOnlyInAll?.usedInternally).toBe(true)
})

// Note: Dynamic imports are not currently tracked by tree-sitter extraction
// This test documents the known limitation
test.skip('dynamic import usage is detected', async () => {
  // Create a file that exports a function
  const lazyFile = join(testDir, 'lazy.ts')
  writeFileSync(lazyFile, `export async function lazyFn() {\n  return 'lazy'\n}`)
  
  // Create a consumer that uses dynamic import
  const consumerFile = join(testDir, 'dynamic-consumer.ts')
  writeFileSync(consumerFile, `
    export async function loadLazy() {
      const mod = await import('./lazy')
      return mod.lazyFn()
    }
  `)
  
  const { execSync } = await import('child_process')
  execSync('git add .', { cwd: testDir })
  
  await repoMap.scan()
  
  const unused = repoMap.getUnusedExports()
  // lazyFn is used via dynamic import, so NOT unused
  // SKIPPED: dynamic imports are not currently tracked
  expect(unused.some(u => u.name === 'lazyFn')).toBe(false)
})

test('identifiers with $ are handled correctly', async () => {
  // Create a file that exports a $-containing identifier (common in Solid.js)
  const fileA = join(testDir, 'dollar-sign.ts')
  writeFileSync(fileA, `export const $state = 42\n\nexport function getState() {\n  return $state\n}`)
  
  const { execSync } = await import('child_process')
  execSync('git add .', { cwd: testDir })
  
  await repoMap.scan()
  
  const unused = repoMap.getUnusedExports()
  // $state is used within the same file, so NOT unused
  expect(unused.some(u => u.name === '$state')).toBe(false)
})
