import { describe, test, expect } from 'vitest'
import { toContainerPath, rewriteOutput, isInsideAnyMount } from '../src/sandbox/path'
import type { SandboxMount } from '../src/sandbox/path'

const WORKTREE_MOUNT: SandboxMount = { hostDir: '/home/user/project', containerDir: '/workspace' }
const PROJECT_MOUNT: SandboxMount = { hostDir: '/home/user/source', containerDir: '/project', readOnly: true }

describe('toContainerPath', () => {
  test('converts host path to container path', () => {
    const result = toContainerPath('/home/user/project/src/file.ts', [WORKTREE_MOUNT])
    expect(result).toBe('/workspace/src/file.ts')
  })

  test('returns path as-is when already a container path', () => {
    const result = toContainerPath('/workspace/src/file.ts', [WORKTREE_MOUNT])
    expect(result).toBe('/workspace/src/file.ts')
  })

  test('returns path as-is when unrelated to any mount', () => {
    const result = toContainerPath('/usr/bin/node', [WORKTREE_MOUNT])
    expect(result).toBe('/usr/bin/node')
  })

  test('converts exact hostDir to /workspace', () => {
    const result = toContainerPath('/home/user/project', [WORKTREE_MOUNT])
    expect(result).toBe('/workspace')
  })

  test('does not match sibling directories with shared prefix', () => {
    const result = toContainerPath('/home/user/project-extra/file.ts', [WORKTREE_MOUNT])
    expect(result).toBe('/home/user/project-extra/file.ts')
  })

  test('does not match /workspace-foo as /workspace', () => {
    const result = toContainerPath('/workspace-foo/file.ts', [WORKTREE_MOUNT])
    expect(result).toBe('/workspace-foo/file.ts')
  })

  test('maps project host path to /project when project mount present', () => {
    const result = toContainerPath('/home/user/source/lib/util.ts', [WORKTREE_MOUNT, PROJECT_MOUNT])
    expect(result).toBe('/project/lib/util.ts')
  })

  test('maps exact project host dir to /project', () => {
    const result = toContainerPath('/home/user/source', [WORKTREE_MOUNT, PROJECT_MOUNT])
    expect(result).toBe('/project')
  })

  test('prefers longer hostDir match when both mounts match', () => {
    const specific: SandboxMount = { hostDir: '/home/user/project/sub', containerDir: '/sub' }
    const result = toContainerPath('/home/user/project/sub/deep/file.ts', [WORKTREE_MOUNT, specific])
    expect(result).toBe('/sub/deep/file.ts')
  })

  test('returns container path as-is when path matches any container dir', () => {
    const result = toContainerPath('/project/lib/util.ts', [WORKTREE_MOUNT, PROJECT_MOUNT])
    expect(result).toBe('/project/lib/util.ts')
  })
})

describe('isInsideAnyMount', () => {
  test('returns true for exact hostDir', () => {
    expect(isInsideAnyMount('/home/user/project', [WORKTREE_MOUNT])).toBe(true)
  })

  test('returns true for a path under hostDir', () => {
    expect(isInsideAnyMount('/home/user/project/src/a.ts', [WORKTREE_MOUNT])).toBe(true)
  })

  test('returns true for exact /workspace', () => {
    expect(isInsideAnyMount('/workspace', [WORKTREE_MOUNT])).toBe(true)
  })

  test('returns true for a path under /workspace', () => {
    expect(isInsideAnyMount('/workspace/src/a.ts', [WORKTREE_MOUNT])).toBe(true)
  })

  test('returns false for unrelated absolute path', () => {
    expect(isInsideAnyMount('/usr/bin/node', [WORKTREE_MOUNT])).toBe(false)
  })

  test('returns false for tool-output directory', () => {
    expect(isInsideAnyMount('/home/user/.local/share/opencode/tool-output/x', [WORKTREE_MOUNT])).toBe(false)
  })

  test('returns false for sibling with shared prefix', () => {
    expect(isInsideAnyMount('/home/user/project-extra/a.ts', [WORKTREE_MOUNT])).toBe(false)
  })

  test('returns false for /workspace-foo sibling', () => {
    expect(isInsideAnyMount('/workspace-foo/a.ts', [WORKTREE_MOUNT])).toBe(false)
  })

  test('returns true for project mount host path', () => {
    expect(isInsideAnyMount('/home/user/source/lib/a.ts', [WORKTREE_MOUNT, PROJECT_MOUNT])).toBe(true)
  })

  test('returns true for project mount container path', () => {
    expect(isInsideAnyMount('/project/lib/a.ts', [WORKTREE_MOUNT, PROJECT_MOUNT])).toBe(true)
  })

  test('returns false for path outside all mounts', () => {
    expect(isInsideAnyMount('/var/log', [WORKTREE_MOUNT, PROJECT_MOUNT])).toBe(false)
  })
})

describe('rewriteOutput', () => {
  test('replaces /workspace/ with hostDir/', () => {
    const result = rewriteOutput('Error at /workspace/src/file.ts:10', [WORKTREE_MOUNT])
    expect(result).toBe('Error at /home/user/project/src/file.ts:10')
  })

  test('replaces /workspace at end of line', () => {
    const result = rewriteOutput('Working dir: /workspace', [WORKTREE_MOUNT])
    expect(result).toBe('Working dir: /home/user/project')
  })

  test('handles multi-line output', () => {
    const input = `Error at /workspace/src/file.ts:10
  at /workspace/lib/utils.ts:25
  Working dir: /workspace`
    const expected = `Error at /home/user/project/src/file.ts:10
  at /home/user/project/lib/utils.ts:25
  Working dir: /home/user/project`
    const result = rewriteOutput(input, [WORKTREE_MOUNT])
    expect(result).toBe(expected)
  })

  test('returns empty string for empty input', () => {
    const result = rewriteOutput('', [WORKTREE_MOUNT])
    expect(result).toBe('')
  })

  test('handles multiple occurrences on same line', () => {
    const result = rewriteOutput('/workspace/a and /workspace/b', [WORKTREE_MOUNT])
    expect(result).toBe('/home/user/project/a and /home/user/project/b')
  })

  test('rewrites /workspace followed by punctuation', () => {
    const result = rewriteOutput('cwd=/workspace: ok', [WORKTREE_MOUNT])
    expect(result).toBe('cwd=/home/user/project: ok')
  })

  test('rewrites /workspace inside quotes', () => {
    const result = rewriteOutput(`path="/workspace/src"`, [WORKTREE_MOUNT])
    expect(result).toBe(`path="/home/user/project/src"`)
  })

  test('rewrites /workspace followed by closing paren', () => {
    const result = rewriteOutput('at (/workspace/file.ts:10)', [WORKTREE_MOUNT])
    expect(result).toBe('at (/home/user/project/file.ts:10)')
  })

  test('rewrites /workspace followed by comma', () => {
    const result = rewriteOutput('dirs=/workspace,/tmp', [WORKTREE_MOUNT])
    expect(result).toBe('dirs=/home/user/project,/tmp')
  })

  test('does not rewrite /workspace-foo as /workspace', () => {
    const result = rewriteOutput('path /workspace-foo/file', [WORKTREE_MOUNT])
    expect(result).toBe('path /workspace-foo/file')
  })

  test('does not rewrite /workspaces as /workspace', () => {
    const result = rewriteOutput('dir /workspaces/x', [WORKTREE_MOUNT])
    expect(result).toBe('dir /workspaces/x')
  })

  test('rewrites /project paths back to project host dir', () => {
    const result = rewriteOutput('Error at /project/lib/util.ts:5', [WORKTREE_MOUNT, PROJECT_MOUNT])
    expect(result).toBe('Error at /home/user/source/lib/util.ts:5')
  })

  test('rewrites both /workspace and /project in same output', () => {
    const input = `/workspace/src/main.ts
/project/src/lib.ts`
    const expected = `/home/user/project/src/main.ts
/home/user/source/src/lib.ts`
    const result = rewriteOutput(input, [WORKTREE_MOUNT, PROJECT_MOUNT])
    expect(result).toBe(expected)
  })

  test('does not rewrite /workspace inside relative path segment', () => {
    const input = 'src/workspace/forge-adapter.ts'
    const result = rewriteOutput(input, [WORKTREE_MOUNT])
    expect(result).toBe('src/workspace/forge-adapter.ts')
  })

  test('does not rewrite /project inside relative path segment', () => {
    const input = 'some/project/file.ts'
    const result = rewriteOutput(input, [WORKTREE_MOUNT, PROJECT_MOUNT])
    expect(result).toBe('some/project/file.ts')
  })

  test('does not rewrite /workspace when preceded by word char', () => {
    const input = 'config/workspace/setup.sh'
    const result = rewriteOutput(input, [WORKTREE_MOUNT])
    expect(result).toBe('config/workspace/setup.sh')
  })

  test('does not rewrite /workspace when preceded by slash in longer path', () => {
    const input = '/home/user/project/workspace/file.ts'
    const result = rewriteOutput(input, [WORKTREE_MOUNT])
    expect(result).toBe('/home/user/project/workspace/file.ts')
  })

  test('rewrites /workspace when preceded by non-word char like space', () => {
    const result = rewriteOutput('Error at /workspace/file.ts:10', [WORKTREE_MOUNT])
    expect(result).toBe('Error at /home/user/project/file.ts:10')
  })

  test('rewrites /workspace when preceded by equals sign', () => {
    const result = rewriteOutput('cwd=/workspace/src', [WORKTREE_MOUNT])
    expect(result).toBe('cwd=/home/user/project/src')
  })
})
