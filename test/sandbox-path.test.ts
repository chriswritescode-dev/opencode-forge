import { describe, test, expect } from 'bun:test'
import { toContainerPath, rewriteOutput } from '../src/sandbox/path'

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

  test('does not match sibling directories with shared prefix', () => {
    const result = toContainerPath('/home/user/project-extra/file.ts', '/home/user/project')
    expect(result).toBe('/home/user/project-extra/file.ts')
  })

  test('does not match /workspace-foo as /workspace', () => {
    const result = toContainerPath('/workspace-foo/file.ts', '/home/user/project')
    expect(result).toBe('/workspace-foo/file.ts')
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

  test('rewrites /workspace followed by punctuation', () => {
    const result = rewriteOutput('cwd=/workspace: ok', '/home/user/project')
    expect(result).toBe('cwd=/home/user/project: ok')
  })

  test('rewrites /workspace inside quotes', () => {
    const result = rewriteOutput(`path="/workspace/src"`, '/home/user/project')
    expect(result).toBe(`path="/home/user/project/src"`)
  })

  test('rewrites /workspace followed by closing paren', () => {
    const result = rewriteOutput('at (/workspace/file.ts:10)', '/home/user/project')
    expect(result).toBe('at (/home/user/project/file.ts:10)')
  })

  test('rewrites /workspace followed by comma', () => {
    const result = rewriteOutput('dirs=/workspace,/tmp', '/home/user/project')
    expect(result).toBe('dirs=/home/user/project,/tmp')
  })

  test('does not rewrite /workspace-foo as /workspace', () => {
    const result = rewriteOutput('path /workspace-foo/file', '/home/user/project')
    expect(result).toBe('path /workspace-foo/file')
  })

  test('does not rewrite /workspaces as /workspace', () => {
    const result = rewriteOutput('dir /workspaces/x', '/home/user/project')
    expect(result).toBe('dir /workspaces/x')
  })
})
