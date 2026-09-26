export const SESSION_AUTO_APPROVE_MAX_ANCESTOR_HOPS = 20

export type SessionAutoApproveFlagResult =
  | { enabled: true; flagOwnerId: string }
  | { enabled: false; error?: unknown }

export interface ResolveSessionAutoApproveFlagInput {
  sessionID: string
  isEnabled: (sessionID: string) => boolean | Promise<boolean>
  getParentId: (sessionID: string) => Promise<string | null>
  isInActiveLoop: (sessionID: string) => Promise<boolean>
}

/**
 * Resolves whether per-session auto-approve is on for `sessionID` or any ancestor, walking up at
 * most `SESSION_AUTO_APPROVE_MAX_ANCESTOR_HOPS` hops and stopping on a cycle. A session inside an
 * active loop never qualifies. Any lookup failure answers disabled so callers fail closed; the error is
 * returned for the caller to log.
 */
export async function resolveSessionAutoApproveFlag(
  input: ResolveSessionAutoApproveFlagInput,
): Promise<SessionAutoApproveFlagResult> {
  try {
    if (await input.isInActiveLoop(input.sessionID)) return { enabled: false }

    const visited = new Set<string>()
    let currentId: string | null = input.sessionID
    for (let hop = 0; currentId && hop < SESSION_AUTO_APPROVE_MAX_ANCESTOR_HOPS; hop++) {
      if (visited.has(currentId)) break
      visited.add(currentId)
      if (await input.isEnabled(currentId)) return { enabled: true, flagOwnerId: currentId }
      currentId = await input.getParentId(currentId)
    }

    return { enabled: false }
  } catch (error) {
    return { enabled: false, error }
  }
}
