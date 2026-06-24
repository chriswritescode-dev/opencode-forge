import type { OpencodeSessionRow } from './opencode-types'
import { deriveSidebarLabel } from './helpers'

// ---------------------------------------------------------------------------
// SessionProjectGroup
// ---------------------------------------------------------------------------

export interface SessionProjectGroup {
  key: string
  label: string
  directory: string | null
  sessions: OpencodeSessionRow[]
  latestUpdated: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a grouping key for a session, preferring directory first, then
 * projectName, then a fallback that collects all ungroupable sessions under
 * one roof.
 */
export function sessionProjectKey(session: OpencodeSessionRow): string {
  if (session.directory) return session.directory
  if (session.projectName) return session.projectName
  return '(unknown)'
}

/**
 * Derive a human-readable group label for a session:
 *  1. `projectName` when present,
 *  2. last path segment of `directory`,
 *  3. fallback placeholder.
 */
export function sessionProjectLabel(session: OpencodeSessionRow): string {
  if (session.projectName) return session.projectName
  if (session.directory) return deriveSidebarLabel(session.directory)
  return '(unknown project)'
}

/**
 * Group a flat list of sessions by project, returning sorted groups.
 *
 * - Sessions are grouped by `sessionProjectKey`.
 * - Group `label` comes from the first session's label.
 * - Group `directory` is the first non-null directory among members.
 * - Sessions within each group are sorted by `timeUpdated DESC` (nulls last).
 * - Groups are sorted by `label.localeCompare(...)`, case-insensitive, with
 *   tie-break by `key`.
 */
export function groupSessionsByProject(
  sessions: OpencodeSessionRow[],
): SessionProjectGroup[] {
  const groups = new Map<string, SessionProjectGroup>()

  for (const session of sessions) {
    const key = sessionProjectKey(session)
    let group = groups.get(key)
    if (!group) {
      group = {
        key,
        label: sessionProjectLabel(session),
        directory: session.directory,
        sessions: [],
        latestUpdated: session.timeUpdated ?? 0,
      }
      groups.set(key, group)
    }
    group.sessions.push(session)

    // Update directory to first non-null value
    if (group.directory === null && session.directory !== null) {
      group.directory = session.directory
    }

    // Track the latest update timestamp
    if ((session.timeUpdated ?? 0) > group.latestUpdated) {
      group.latestUpdated = session.timeUpdated ?? 0
    }
  }

  // Sort sessions within each group: timeUpdated DESC, nulls last
  for (const group of groups.values()) {
    group.sessions.sort((a, b) => {
      const ta = a.timeUpdated ?? 0
      const tb = b.timeUpdated ?? 0
      if (ta !== tb) return tb - ta // DESC
      return 0
    })
  }

  // Sort groups by label (case-insensitive), tie-break by key
  return [...groups.values()].sort((a, b) => {
    const cmp = a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
    if (cmp !== 0) return cmp
    return a.key.localeCompare(b.key)
  })
}

/**
 * Find which project group key contains a given session id, or return null.
 */
export function findSessionProjectKey(
  groups: SessionProjectGroup[],
  sessionId: string,
): string | null {
  for (const group of groups) {
    for (const session of group.sessions) {
      if (session.id === sessionId) return group.key
    }
  }
  return null
}

/**
 * Derive the set of project group keys that contain a currently-running
 * session. A project lights up when any of its sessions is in `busySessionIds`
 * (sourced from opencode's authoritative `session.status` events), so the
 * indicator reflects real run state rather than a recency heuristic.
 */
export function activeProjectKeys(
  busySessionIds: Set<string>,
  groups: SessionProjectGroup[],
): Set<string> {
  const keys = new Set<string>()
  if (busySessionIds.size === 0) return keys
  for (const group of groups) {
    if (group.sessions.some((s) => busySessionIds.has(s.id))) keys.add(group.key)
  }
  return keys
}

/** Shallow set-equality used to debounce the active-project indicator memo. */
export function projectKeySetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const key of a) if (!b.has(key)) return false
  return true
}
