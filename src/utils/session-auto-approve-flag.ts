import { findSessionAncestor } from './session-ancestry'

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
 * Resolves whether per-session auto-approve is on for `sessionID` or any ancestor, walking the
 * ancestry chain through the shared `findSessionAncestor` helper (which stops on a cycle). The flag
 * lookup runs first — the session itself, then its ancestors — and only a resolved flag owner is
 * checked against the active-loop rule. Any lookup failure answers disabled so callers fail closed;
 * the error is returned for the caller to log.
 */
export async function resolveSessionAutoApproveFlag(
  input: ResolveSessionAutoApproveFlagInput,
): Promise<SessionAutoApproveFlagResult> {
  try {
    const ownerId = (await input.isEnabled(input.sessionID))
      ? input.sessionID
      : await findSessionAncestor(input.sessionID, input.getParentId, async (id) => ((await input.isEnabled(id)) ? id : null))
    if (!ownerId) return { enabled: false }
    if (await input.isInActiveLoop(input.sessionID)) return { enabled: false }
    return { enabled: true, flagOwnerId: ownerId }
  } catch (error) {
    return { enabled: false, error }
  }
}
