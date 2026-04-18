import { test, expect, beforeEach, afterEach } from 'bun:test'
import { TreeSitterBackend } from '../src/graph/tree-sitter'
import { FileCache } from '../src/graph/cache'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'

let testDir: string
let treeSitter: TreeSitterBackend
let cache: FileCache

beforeEach(async () => {
  testDir = join('/tmp', `tree-sitter-test-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
  
  // Initialize git repo
  execSync('git init', { cwd: testDir })
  execSync('git config user.email "test@test.com"', { cwd: testDir })
  execSync('git config user.name "Test"', { cwd: testDir })
  
  treeSitter = new TreeSitterBackend()
  cache = new FileCache(200)
  treeSitter.setCache(cache)
  await treeSitter.initialize(testDir)
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
  treeSitter.dispose()
})

test('exported function declaration produces exactly one symbol', async () => {
  // Create a file with an exported function
  const testFile = join(testDir, 'index.ts')
  const content = `export function createCacheService(ttlSeconds?: number) {
  return null
}`
  writeFileSync(testFile, content)
  execSync('git add .', { cwd: testDir })
  
  const outline = await treeSitter.getFileOutline(testFile)
  
  expect(outline).not.toBeNull()
  expect(outline!.symbols).toHaveLength(1)
  expect(outline!.symbols[0].name).toBe('createCacheService')
  expect(outline!.symbols[0].kind).toBe('function')
  expect(outline!.symbols[0].location.line).toBe(1)
  
  // Verify exports are also correct
  expect(outline!.exports).toHaveLength(1)
  expect(outline!.exports[0].name).toBe('createCacheService')
})

test('distinct files with same symbol name both return symbols', async () => {
  // Create two files with the same function name
  const fileA = join(testDir, 'a.ts')
  writeFileSync(fileA, `export function duplicate() {
  return 'a'
}`)
  
  const fileB = join(testDir, 'b.ts')
  writeFileSync(fileB, `export function duplicate() {
  return 'b'
}`)
  
  execSync('git add .', { cwd: testDir })
  
  const outlineA = await treeSitter.getFileOutline(fileA)
  const outlineB = await treeSitter.getFileOutline(fileB)
  
  // Both files should have the symbol
  expect(outlineA!.symbols).toHaveLength(1)
  expect(outlineA!.symbols[0].name).toBe('duplicate')
  
  expect(outlineB!.symbols).toHaveLength(1)
  expect(outlineB!.symbols[0].name).toBe('duplicate')
})

test('exported class declaration produces exactly one class symbol', async () => {
  const testFile = join(testDir, 'class.ts')
  writeFileSync(testFile, `export class MyClass {
  constructor() {}
  method() {}
}`)
  execSync('git add .', { cwd: testDir })
  
  const outline = await treeSitter.getFileOutline(testFile)
  
  expect(outline).not.toBeNull()
  // Class has methods which are also captured, so check for exactly 1 class symbol
  const classSymbols = outline!.symbols.filter(s => s.kind === 'class')
  expect(classSymbols).toHaveLength(1)
  expect(classSymbols[0].name).toBe('MyClass')
  expect(classSymbols[0].location.line).toBe(1)
})

test('exported variable declaration produces exactly one symbol', async () => {
  const testFile = join(testDir, 'var.ts')
  writeFileSync(testFile, `export const myConstant = 42`)
  execSync('git add .', { cwd: testDir })
  
  const outline = await treeSitter.getFileOutline(testFile)
  
  expect(outline).not.toBeNull()
  expect(outline!.symbols).toHaveLength(1)
  expect(outline!.symbols[0].name).toBe('myConstant')
  expect(outline!.symbols[0].kind).toBe('variable')
})

test('multiple symbols in same file all appear once', async () => {
  const testFile = join(testDir, 'multi.ts')
  writeFileSync(testFile, `export function func1() {}
export function func2() {}
export const myVar = 1
export class MyClass {}`)
  execSync('git add .', { cwd: testDir })
  
  const outline = await treeSitter.getFileOutline(testFile)
  
  expect(outline).not.toBeNull()
  expect(outline!.symbols).toHaveLength(4)
  
  const names = outline!.symbols.map(s => s.name)
  expect(names).toEqual(['func1', 'func2', 'myVar', 'MyClass'])
})

test('non-exported function declaration produces one symbol', async () => {
  const testFile = join(testDir, 'internal.ts')
  writeFileSync(testFile, `function internalFunc() {
  return 'internal'
}`)
  execSync('git add .', { cwd: testDir })
  
  const outline = await treeSitter.getFileOutline(testFile)
  
  expect(outline).not.toBeNull()
  expect(outline!.symbols).toHaveLength(1)
  expect(outline!.symbols[0].name).toBe('internalFunc')
})

test('static value import sets isTypeOnly=false, isDynamic=false', async () => {
  const testFile = join(testDir, 'imports.ts')
  writeFileSync(testFile, `import { foo } from './foo'`)
  execSync('git add .', { cwd: testDir })
  
  const outline = await treeSitter.getFileOutline(testFile)
  
  expect(outline).not.toBeNull()
  expect(outline!.imports).toHaveLength(1)
  const imp = outline!.imports[0]
  expect(imp.source).toBe('./foo')
  expect(imp.specifiers).toEqual(['foo'])
  expect(imp.isTypeOnly).toBe(false)
  expect(imp.isDynamic).toBe(false)
})

test('top-level import type sets isTypeOnly=true', async () => {
  const testFile = join(testDir, 'type-import.ts')
  writeFileSync(testFile, `import type { Foo } from './types'`)
  execSync('git add .', { cwd: testDir })
  
  const outline = await treeSitter.getFileOutline(testFile)
  
  expect(outline).not.toBeNull()
  expect(outline!.imports).toHaveLength(1)
  const imp = outline!.imports[0]
  expect(imp.source).toBe('./types')
  expect(imp.specifiers).toEqual(['Foo'])
  expect(imp.isTypeOnly).toBe(true)
  expect(imp.isDynamic).toBe(false)
})

test('per-specifier type imports are stripped from specifiers', async () => {
  const testFile = join(testDir, 'mixed-import.ts')
  writeFileSync(testFile, `import { type Foo, bar } from './mixed'`)
  execSync('git add .', { cwd: testDir })
  
  const outline = await treeSitter.getFileOutline(testFile)
  
  expect(outline).not.toBeNull()
  expect(outline!.imports).toHaveLength(1)
  const imp = outline!.imports[0]
  expect(imp.source).toBe('./mixed')
  expect(imp.specifiers).toEqual(['bar'])
  expect(imp.isTypeOnly).toBe(false)
  expect(imp.isDynamic).toBe(false)
})

test('all per-specifier type imports sets isTypeOnly=true', async () => {
  const testFile = join(testDir, 'all-type-import.ts')
  writeFileSync(testFile, `import { type Foo, type Bar } from './types'`)
  execSync('git add .', { cwd: testDir })
  
  const outline = await treeSitter.getFileOutline(testFile)
  
  expect(outline).not.toBeNull()
  expect(outline!.imports).toHaveLength(1)
  const imp = outline!.imports[0]
  expect(imp.source).toBe('./types')
  expect(imp.specifiers).toEqual([])
  expect(imp.isTypeOnly).toBe(true)
  expect(imp.isDynamic).toBe(false)
})

test('dynamic await import produces an ImportInfo with isDynamic=true and source', async () => {
  const testFile = join(testDir, 'dynamic.ts')
  writeFileSync(testFile, `async function load() {
  await import('./dynamic-module')
}`)
  execSync('git add .', { cwd: testDir })
  
  const outline = await treeSitter.getFileOutline(testFile)
  
  expect(outline).not.toBeNull()
  expect(outline!.imports).toHaveLength(1)
  const imp = outline!.imports[0]
  expect(imp.source).toBe('./dynamic-module')
  expect(imp.specifiers).toEqual([])
  expect(imp.isTypeOnly).toBe(false)
  expect(imp.isDynamic).toBe(true)
})

test('static + dynamic import in same file produces 2 imports', async () => {
  const testFile = join(testDir, 'both.ts')
  writeFileSync(testFile, `import { foo } from './foo'
async function load() {
  await import('./dynamic')
}`)
  execSync('git add .', { cwd: testDir })
  
  const outline = await treeSitter.getFileOutline(testFile)
  
  expect(outline).not.toBeNull()
  expect(outline!.imports).toHaveLength(2)
  const staticImp = outline!.imports.find(i => !i.isDynamic)
  const dynamicImp = outline!.imports.find(i => i.isDynamic)
  expect(staticImp).toBeDefined()
  expect(staticImp!.source).toBe('./foo')
  expect(staticImp!.specifiers).toEqual(['foo'])
  expect(dynamicImp).toBeDefined()
  expect(dynamicImp!.source).toBe('./dynamic')
  expect(dynamicImp!.specifiers).toEqual([])
})
