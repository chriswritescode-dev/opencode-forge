import { describe, test, expect } from 'vitest'
import { isSameOrDescendantPath, isInsideAnyMount } from '../src/sandbox/path'
import type { SandboxMount } from '../src/sandbox/path'

const WORKTREE_MOUNT: SandboxMount = { hostDir: '/home/user/project', containerDir: '/workspace' }
const PROJECT_MOUNT: SandboxMount = { hostDir: '/home/user/source', containerDir: '/project', readOnly: true }

describe('isSameOrDescendantPath', () => {
  test('returns true for exact match', () => {
    expect(isSameOrDescendantPath('/home/user/project', '/home/user/project')).toBe(true)
  })

  test('returns true for a descendant path', () => {
    expect(isSameOrDescendantPath('/home/user/project/src/a.ts', '/home/user/project')).toBe(true)
  })

  test('returns false for a sibling with shared prefix', () => {
    expect(isSameOrDescendantPath('/home/user/project-extra/a.ts', '/home/user/project')).toBe(false)
  })

  test('returns false for an unrelated path', () => {
    expect(isSameOrDescendantPath('/usr/bin/node', '/home/user/project')).toBe(false)
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
