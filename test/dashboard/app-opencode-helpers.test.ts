import { describe, test, expect } from 'vitest'
import type { OpencodeSessionRow } from '../../src/dashboard/app/opencode-types'
import {
  sessionProjectKey,
  sessionProjectLabel,
  groupSessionsByProject,
  findSessionProjectKey,
  type SessionProjectGroup,
} from '../../src/dashboard/app/opencode-helpers'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function mockSession(id: string, overrides: Partial<OpencodeSessionRow> = {}): OpencodeSessionRow {
  return {
    id,
    title: null,
    directory: null,
    projectName: null,
    worktree: null,
    agent: null,
    modelId: null,
    providerId: null,
    cost: 0,
    tokensInput: 0,
    tokensOutput: 0,
    tokensReasoning: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    timeCreated: null,
    timeUpdated: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// sessionProjectKey
// ---------------------------------------------------------------------------

describe('sessionProjectKey', () => {
  test('prefers directory when present', () => {
    const s = mockSession('s1', { directory: '/proj/foo', projectName: 'Foo' })
    expect(sessionProjectKey(s)).toBe('/proj/foo')
  })

  test('falls back to projectName when directory is null', () => {
    const s = mockSession('s1', { directory: null, projectName: 'Foo' })
    expect(sessionProjectKey(s)).toBe('Foo')
  })

  test('returns "(unknown)" when both directory and projectName are null', () => {
    const s = mockSession('s1', { directory: null, projectName: null })
    expect(sessionProjectKey(s)).toBe('(unknown)')
  })
})

// ---------------------------------------------------------------------------
// sessionProjectLabel
// ---------------------------------------------------------------------------

describe('sessionProjectLabel', () => {
  test('prefers projectName when present', () => {
    const s = mockSession('s1', { projectName: 'My Project', directory: '/some/path' })
    expect(sessionProjectLabel(s)).toBe('My Project')
  })

  test('derives label from directory basename when projectName is null', () => {
    const s = mockSession('s1', { projectName: null, directory: '/Users/me/dev/my-app' })
    expect(sessionProjectLabel(s)).toBe('my-app')
  })

  test('handles directory with trailing slash', () => {
    const s = mockSession('s1', { projectName: null, directory: '/foo/bar/' })
    expect(sessionProjectLabel(s)).toBe('bar')
  })

  test('returns raw directory when it has no path segments beyond root', () => {
    const s = mockSession('s1', { projectName: null, directory: '/' })
    expect(sessionProjectLabel(s)).toBe('/')
  })

  test('returns fallback when both projectName and directory are null', () => {
    const s = mockSession('s1', { projectName: null, directory: null })
    expect(sessionProjectLabel(s)).toBe('(unknown project)')
  })
})

// ---------------------------------------------------------------------------
// groupSessionsByProject
// ---------------------------------------------------------------------------

describe('groupSessionsByProject', () => {
  test('groups sessions from the same directory together regardless of input order', () => {
    const sessions = [
      mockSession('s1', { directory: '/proj/alpha', projectName: 'Alpha', timeUpdated: 100 }),
      mockSession('s2', { directory: '/proj/beta', projectName: 'Beta', timeUpdated: 200 }),
      mockSession('s3', { directory: '/proj/alpha', projectName: 'Alpha', timeUpdated: 300 }),
    ]
    const groups = groupSessionsByProject(sessions)
    expect(groups).toHaveLength(2)
    const alpha = groups.find((g) => g.key === '/proj/alpha')!
    expect(alpha.sessions).toHaveLength(2)
    const beta = groups.find((g) => g.key === '/proj/beta')!
    expect(beta.sessions).toHaveLength(1)
  })

  test('group label is derived from the first session label', () => {
    const sessions = [
      mockSession('s1', { directory: '/proj/alpha', projectName: 'Alpha', timeUpdated: 100 }),
      mockSession('s2', { directory: '/proj/alpha', projectName: null, timeUpdated: 200 }),
    ]
    const groups = groupSessionsByProject(sessions)
    const alpha = groups.find((g) => g.key === '/proj/alpha')!
    // First session has projectName so label should reflect that
    expect(alpha.label).toBe('Alpha')
  })

  test('group directory is first non-null directory among members', () => {
    const sessions = [
      mockSession('s1', { directory: null, projectName: 'Proj', timeUpdated: 100 }),
      mockSession('s2', { directory: '/proj/proj', projectName: 'Proj', timeUpdated: 200 }),
    ]
    const groups = groupSessionsByProject(sessions)
    const group = groups.find((g) => g.key === 'Proj')!
    expect(group.directory).toBeNull() // first session had null directory
  })

  test('sessions inside a group are sorted newest first by timeUpdated', () => {
    const sessions = [
      mockSession('s1', { directory: '/proj/foo', timeUpdated: 1000 }),
      mockSession('s2', { directory: '/proj/foo', timeUpdated: 3000 }),
      mockSession('s3', { directory: '/proj/foo', timeUpdated: 2000 }),
    ]
    const groups = groupSessionsByProject(sessions)
    expect(groups).toHaveLength(1)
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['s2', 's3', 's1'])
  })

  test('sessions with null timeUpdated sort last', () => {
    const sessions = [
      mockSession('s1', { directory: '/proj/foo', timeUpdated: 100 }),
      mockSession('s2', { directory: '/proj/foo', timeUpdated: null }),
    ]
    const groups = groupSessionsByProject(sessions)
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['s1', 's2'])
  })

  test('groups are sorted alphabetically by label (case-insensitive)', () => {
    const sessions = [
      mockSession('s1', { directory: '/proj/zeta', projectName: 'Zeta', timeUpdated: 100 }),
      mockSession('s2', { directory: '/proj/alpha', projectName: 'Alpha', timeUpdated: 100 }),
      mockSession('s3', { directory: '/proj/beta', projectName: 'Beta', timeUpdated: 100 }),
    ]
    const groups = groupSessionsByProject(sessions)
    expect(groups.map((g) => g.label)).toEqual(['Alpha', 'Beta', 'Zeta'])
  })

  test('groups with same case-insensitive label tie-break by key', () => {
    const sessions = [
      mockSession('s1', { directory: '/proj/foo', projectName: 'Project', timeUpdated: 100 }),
      // Same projectName but different directory -> different keys
      mockSession('s2', { directory: '/proj/bar', projectName: 'Project', timeUpdated: 100 }),
    ]
    const groups = groupSessionsByProject(sessions)
    expect(groups).toHaveLength(2)
    expect(groups[0].key.localeCompare(groups[1].key)).toBeLessThan(0)
  })

  test('latestUpdated reflects the maximum timeUpdated in each group', () => {
    const sessions = [
      mockSession('s1', { directory: '/proj/foo', timeUpdated: 100 }),
      mockSession('s2', { directory: '/proj/foo', timeUpdated: 999 }),
      mockSession('s3', { directory: '/proj/foo', timeUpdated: 500 }),
    ]
    const groups = groupSessionsByProject(sessions)
    expect(groups[0].latestUpdated).toBe(999)
  })

  test('handles empty sessions array', () => {
    const groups = groupSessionsByProject([])
    expect(groups).toEqual([])
  })

  test('handles sessions with only directory (no projectName)', () => {
    const sessions = [
      mockSession('s1', { directory: '/proj/alpha', projectName: null, timeUpdated: 100 }),
      mockSession('s2', { directory: '/proj/alpha', projectName: null, timeUpdated: 200 }),
    ]
    const groups = groupSessionsByProject(sessions)
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('alpha')
    expect(groups[0].directory).toBe('/proj/alpha')
  })

  test('ungroupable sessions fall under "(unknown)" key', () => {
    const sessions = [
      mockSession('s1', { directory: null, projectName: null, timeUpdated: 100 }),
      mockSession('s2', { directory: null, projectName: null, timeUpdated: 200 }),
    ]
    const groups = groupSessionsByProject(sessions)
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('(unknown)')
    expect(groups[0].label).toBe('(unknown project)')
    expect(groups[0].directory).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// findSessionProjectKey
// ---------------------------------------------------------------------------

describe('findSessionProjectKey', () => {
  const groups: SessionProjectGroup[] = [
    {
      key: '/proj/alpha',
      label: 'Alpha',
      directory: '/proj/alpha',
      sessions: [mockSession('s1', { directory: '/proj/alpha' }), mockSession('s2', { directory: '/proj/alpha' })],
      latestUpdated: 200,
    },
    {
      key: '/proj/beta',
      label: 'Beta',
      directory: '/proj/beta',
      sessions: [mockSession('s3', { directory: '/proj/beta' })],
      latestUpdated: 100,
    },
  ]

  test('returns group key for a session that exists', () => {
    expect(findSessionProjectKey(groups, 's1')).toBe('/proj/alpha')
    expect(findSessionProjectKey(groups, 's2')).toBe('/proj/alpha')
    expect(findSessionProjectKey(groups, 's3')).toBe('/proj/beta')
  })

  test('returns null for a session id not in any group', () => {
    expect(findSessionProjectKey(groups, 'nonexistent')).toBeNull()
  })

  test('returns null for empty groups array', () => {
    expect(findSessionProjectKey([], 's1')).toBeNull()
  })

  test('returns null for empty string session id', () => {
    expect(findSessionProjectKey(groups, '')).toBeNull()
  })
})
