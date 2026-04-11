import { describe, test, expect } from 'bun:test'
import { toContainerPath, toHostPath, rewriteOutput } from '../src/sandbox/path'

describe('toContainerPath', () => {
  test('converts host path to container path', () => {
    const result = toContainerPath('/home/user/project/src/file.ts', '/home/user/project')
    expect(result).toBe('/workspace/src/file.ts')
  })

  test('returns path as-is when already a container path', () => {
    const result = toContainerPath('/workspace/src/file.ts', '/home/user/project')
    expect(result).toBe('/workspace/src/file.ts')
  })

  test('returns path as-is when unrelated to hostDir', () => {
    const result = toContainerPath('/usr/bin/node', '/home/user/project')
    expect(result).toBe('/usr/bin/node')
  })

  test('converts exact hostDir to /workspace', () => {
    const result = toContainerPath('/home/user/project', '/home/user/project')
    expect(result).toBe('/workspace')
  })
})

describe('toHostPath', () => {
  test('converts container path to host path', () => {
    const result = toHostPath('/workspace/src/file.ts', '/home/user/project')
    expect(result).toBe('/home/user/project/src/file.ts')
  })

  test('returns absolute non-workspace paths unchanged', () => {
    const result = toHostPath('/usr/bin/node', '/home/user/project')
    expect(result).toBe('/usr/bin/node')
  })

  test('treats relative paths as relative to workspace', () => {
    const result = toHostPath('src/file.ts', '/home/user/project')
    expect(result).toBe('/home/user/project/src/file.ts')
  })

  test('converts exact /workspace to hostDir', () => {
    const result = toHostPath('/workspace', '/home/user/project')
    expect(result).toBe('/home/user/project')
  })
})

describe('rewriteOutput', () => {
  test('replaces /workspace/ with hostDir/', () => {
    const result = rewriteOutput('Error at /workspace/src/file.ts:10', '/home/user/project')
    expect(result).toBe('Error at /home/user/project/src/file.ts:10')
  })

  test('replaces /workspace at end of line', () => {
    const result = rewriteOutput('Working dir: /workspace', '/home/user/project')
    expect(result).toBe('Working dir: /home/user/project')
  })

  test('handles multi-line output', () => {
    const input = `Error at /workspace/src/file.ts:10
  at /workspace/lib/utils.ts:25
  Working dir: /workspace`
    const expected = `Error at /home/user/project/src/file.ts:10
  at /home/user/project/lib/utils.ts:25
  Working dir: /home/user/project`
    const result = rewriteOutput(input, '/home/user/project')
    expect(result).toBe(expected)
  })

  test('returns empty string for empty input', () => {
    const result = rewriteOutput('', '/home/user/project')
    expect(result).toBe('')
  })

  test('handles multiple occurrences on same line', () => {
    const result = rewriteOutput('/workspace/a and /workspace/b', '/home/user/project')
    expect(result).toBe('/home/user/project/a and /home/user/project/b')
  })
})
