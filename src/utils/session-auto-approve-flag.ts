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
