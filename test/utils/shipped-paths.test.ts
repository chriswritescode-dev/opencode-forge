import { describe, test, expect } from 'vitest'
import { pathToFileURL } from 'url'
import { resolveShippedRoot } from '../../src/utils/shipped-paths'

function url(absPath: string): string {
  return pathToFileURL(absPath).href
}

describe('resolveShippedRoot', () => {
  test('resolves the dist root for each unbundled tsc layout module', () => {
    expect(resolveShippedRoot(url('/repo/dist/install/paths.js'))).toBe('/repo/dist')
    expect(resolveShippedRoot(url('/repo/dist/storage/migrations/index.js'))).toBe('/repo/dist')
    expect(resolveShippedRoot(url('/repo/dist/prompts/loader.js'))).toBe('/repo/dist')
  })

  test('resolves the dist root for a future bundled server entry', () => {
    expect(resolveShippedRoot(url('/repo/dist/index.js'))).toBe('/repo/dist')
  })

  test('resolves the dist root for the bundled installer cli', () => {
    expect(resolveShippedRoot(url('/repo/dist/install/cli.js'))).toBe('/repo/dist')
  })

  test('resolves the src root when running from source', () => {
    expect(resolveShippedRoot(url('/repo/src/install/paths.ts'))).toBe('/repo/src')
  })

  test('nearest match wins over a higher src or dist ancestor', () => {
    expect(resolveShippedRoot(url('/Users/x/src/project/dist/storage/migrations/index.js'))).toBe(
      '/Users/x/src/project/dist'
    )
  })

  test('returns the starting directory when no dist or src ancestor exists', () => {
    expect(resolveShippedRoot(url('/Users/x/project/lib/foo.js'))).toBe('/Users/x/project/lib')
  })

  test('returns dist when the module is directly inside dist', () => {
    expect(resolveShippedRoot(url('/repo/dist/index.js'))).toBe('/repo/dist')
  })
})
