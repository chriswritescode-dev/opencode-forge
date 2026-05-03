import { describe, test, expect } from 'bun:test'
import { spawnSync } from 'child_process'

describe('CLI index routing', () => {
  test('nested loop help reaches the status command', () => {
    const result = spawnSync('bun', ['src/cli/index.ts', 'loop', 'status', '--help'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Show loop status')
    expect(result.stdout).toContain('oc-forge loop status')
  })


})
