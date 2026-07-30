import type { ToolContext } from './types'

export function assertWritableSession(
  ctx: ToolContext,
  sessionID: string,
  opts: { artifactLabel: string; amendGuidance: string },
): string | null {
  const state = ctx.loop.service.resolveActiveLoopForSession(sessionID)
  if (state) {
    return (
      `Cannot modify the ${opts.artifactLabel} from an active loop session (loop: ${state.loopName}). ` +
      opts.amendGuidance
    )
  }
  return null
}
