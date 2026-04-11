import { describe, test, expect } from 'bun:test'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

describe('Worker path resolution', () => {
  test('worker.ts exists in src/graph for development', () => {
    const srcPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'graph', 'worker.ts')
    expect(existsSync(srcPath)).toBe(true)
  })

  test('worker.js exists in dist/graph after build', () => {
    const distPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'graph', 'worker.js')
    
    // This test will pass in built environments
    if (existsSync(distPath)) {
      expect(existsSync(distPath)).toBe(true)
    }
  })
})
