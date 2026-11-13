export const MAX_SESSION_TITLE_LENGTH = 60

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
    parts.push(`${ctx.currentSectionIndex + 1}/${ctx.totalSections}`)
  }
  parts.push(`#${ctx.iteration}`)
  return ` ${parts.join(' ')}`
}

export function formatLoopSessionTitle(loopName: string, ctx?: LoopTitleContext): string {
  const stripped = loopName.startsWith('Loop: ') ? loopName.slice('Loop: '.length) : loopName
  return truncateSessionTitle(`Loop: ${stripped}${buildSuffix(ctx)}`)
}

export function formatPlanSessionTitle(title: string): string {
  return truncateSessionTitle(title)
}

export function formatAuditSessionTitle(loopName: string, ctx: LoopTitleContext): string {
  return truncateSessionTitle(`audit: ${loopName}${buildSuffix(ctx)}`)
}

export function formatPostActionSessionTitle(loopName: string): string {
  return truncateSessionTitle(`action: ${loopName}`)
}
