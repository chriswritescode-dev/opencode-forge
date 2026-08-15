export const MAX_SESSION_ANCESTOR_DEPTH = 10

/**
 * Raised when a session's parent could not be read at all, as opposed to the session definitively
 * having no parent. The two must never collapse into the same `null`: sandbox routing reads "no
 * parent" as "not a descendant of the sandboxed session" and would run the command on the host.
 */
export class ParentLookupUndeterminedError extends Error {
  readonly sessionId: string

  constructor(sessionId: string, detail: string) {
    super(`Could not determine the parent session of ${sessionId}: ${detail}`)
    this.name = 'ParentLookupUndeterminedError'
    this.sessionId = sessionId
  }
}

/**
 * Runs an ancestor walk for callers whose worst case is losing bookkeeping, not losing isolation
 * (loop name resolution). They keep the pre-existing "unresolved" outcome when ancestry cannot be
 * read; every other failure still propagates. Sandbox routing must never use this.
 */
export async function tolerateUndeterminedParent<T>(walk: Promise<T | null>): Promise<T | null> {
  try {
    return await walk
  } catch (err) {
    if (err instanceof ParentLookupUndeterminedError) return null
    throw err
  }
}

export async function findSessionAncestor<T>(
  sessionId: string,
  getParentSessionId: (sessionId: string) => Promise<string | null>,
  match: (ancestorId: string, depth: number) => T | null | Promise<T | null>,
): Promise<T | null> {
  const seen = new Set<string>([sessionId])
  let current = sessionId
  for (let depth = 0; depth < MAX_SESSION_ANCESTOR_DEPTH; depth++) {
    const parentId = await getParentSessionId(current)
    if (!parentId || seen.has(parentId)) return null
    seen.add(parentId)
    const result = await match(parentId, depth)
    if (result !== null) return result
    current = parentId
  }
  return null
}
