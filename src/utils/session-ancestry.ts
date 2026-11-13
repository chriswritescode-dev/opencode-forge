export const MAX_SESSION_ANCESTOR_DEPTH = 10

export class ParentLookupUndeterminedError extends Error {
  readonly sessionId: string

  constructor(sessionId: string, detail: string) {
    super(`Could not determine the parent session of ${sessionId}: ${detail}`)
    this.name = 'ParentLookupUndeterminedError'
    this.sessionId = sessionId
  }
}

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
