/**
 * Centralized session title helpers for consistent naming across loop and audit sessions.
 */

export const MAX_SESSION_TITLE_LENGTH = 60

/**
 * Truncates a title to the specified length, adding ellipsis if needed.
 */
export function truncateSessionTitle(title: string, maxLength = MAX_SESSION_TITLE_LENGTH): string {
  return title.length > maxLength ? `${title.substring(0, maxLength - 3)}...` : title
}

export interface LoopTitleContext {
  iteration: number
  currentSectionIndex: number
  totalSections: number
}

function buildSuffix(ctx?: LoopTitleContext): string {
  if (!ctx) return ''
  const parts: string[] = []
  if (ctx.totalSections > 0) {
    parts.push(`§${ctx.currentSectionIndex + 1}/${ctx.totalSections}`)
  }
  parts.push(`#${ctx.iteration}`)
  return ` ${parts.join(' ')}`
}

/**
 * Formats a loop session title with 'Loop: ' prefix.
 * Idempotent: will not double-prefix if already prefixed.
 */
export function formatLoopSessionTitle(loopName: string, ctx?: LoopTitleContext): string {
  const stripped = loopName.startsWith('Loop: ') ? loopName.slice('Loop: '.length) : loopName
  return truncateSessionTitle(`Loop: ${stripped}${buildSuffix(ctx)}`)
}

/**
 * Formats a plan execution session title (non-loop).
 */
export function formatPlanSessionTitle(title: string): string {
  return truncateSessionTitle(title)
}

/**
 * Formats an audit session title with loop name and iteration/section context.
 */
export function formatAuditSessionTitle(loopName: string, ctx: LoopTitleContext): string {
  return truncateSessionTitle(`audit: ${loopName}${buildSuffix(ctx)}`)
}

/**
 * Formats a decomposer session title (runs pre-section, pre-iteration).
 */
export function formatDecomposerSessionTitle(loopName: string): string {
  return truncateSessionTitle(`decomposer-${loopName}`)
}
