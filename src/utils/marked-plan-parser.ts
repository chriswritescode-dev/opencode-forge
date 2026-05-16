export const PLAN_START_MARKER = '<!-- forge-plan:start -->'
export const PLAN_END_MARKER = '<!-- forge-plan:end -->'

export interface PlanCaptureMessage {
  info: { role?: string; id?: string; agent?: string }
  parts: Array<{ type: string; text?: string }>
}

export type MarkedPlanExtraction =
  | { ok: true; planText: string }
  | { ok: false; reason: 'missing' | 'multiple' | 'unterminated' | 'empty' }

export type LatestMarkedPlanInspection =
  | { status: 'found'; planText: string; messageId?: string }
  | { status: 'invalid'; reason: Exclude<MarkedPlanExtraction, { ok: true }>['reason']; messageId?: string }
  | { status: 'missing' }

function countPlanMarkers(text: string): { startCount: number; endCount: number } {
  let startCount = 0
  let endCount = 0

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === PLAN_START_MARKER) startCount++
    if (line === PLAN_END_MARKER) endCount++
  }

  return { startCount, endCount }
}

export function extractMarkedPlan(text: string): MarkedPlanExtraction {
  const lines = text.split('\n')
  
  let startIndex = -1
  let endIndex = -1
  let startCount = 0
  let endCount = 0
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === PLAN_START_MARKER) {
      startIndex = i
      startCount++
    }
    if (line === PLAN_END_MARKER) {
      endIndex = i
      endCount++
    }
  }
  
  if (startCount === 0 && endCount === 0) {
    return { ok: false, reason: 'missing' }
  }
  
  if (startCount > 1 || endCount > 1) {
    return { ok: false, reason: 'multiple' }
  }
  
  if (startCount === 1 && endCount === 0) {
    return { ok: false, reason: 'unterminated' }
  }
  
  if (startCount === 0 && endCount === 1) {
    return { ok: false, reason: 'unterminated' }
  }
  
  if (startIndex === -1 || endIndex === -1) {
    return { ok: false, reason: 'unterminated' }
  }
  
  if (endIndex <= startIndex) {
    return { ok: false, reason: 'unterminated' }
  }
  
  const planLines = lines.slice(startIndex + 1, endIndex)
  const planText = planLines.join('\n').trim()
  
  if (planText.length === 0) {
    return { ok: false, reason: 'empty' }
  }
  
  return { ok: true, planText }
}

export function sanitizePlanPaths(planText: string, projectDir: string | undefined): string {
  if (!projectDir) return planText
  const trimmed = projectDir.replace(/\/+$/, '')
  if (!trimmed) return planText

  let result = planText
  const prefixes = new Set<string>()
  prefixes.add(trimmed + '/')

  const home = typeof process !== 'undefined' ? process.env?.HOME : undefined
  if (home && trimmed.startsWith(home + '/')) {
    prefixes.add('~' + trimmed.slice(home.length) + '/')
  }

  for (const prefix of prefixes) {
    result = result.split(prefix).join('')
  }
  return result
}

export function messageText(message: PlanCaptureMessage): string {
  const textParts = message.parts
    .filter((p) => p.type === 'text' && p.text !== undefined)
    .map((p) => p.text!)
  
  return textParts.join('\n')
}

export function inspectLatestMarkedPlan(messages: PlanCaptureMessage[]): LatestMarkedPlanInspection {
  const repaired = inspectLatestPlanCompletedByLaterEndMarker(messages)
  if (repaired) return repaired

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    
    if (message.info.role !== 'assistant') {
      continue
    }
    
    const text = messageText(message)
    const extraction = extractMarkedPlan(text)
    
    if (extraction.ok) {
      return {
        status: 'found',
        planText: extraction.planText,
        messageId: message.info.id,
      }
    }
    
    if (!extraction.ok && extraction.reason !== 'missing') {
      return {
        status: 'invalid',
        reason: extraction.reason,
        messageId: message.info.id,
      }
    }
  }
  
  return { status: 'missing' }
}

function inspectLatestPlanCompletedByLaterEndMarker(messages: PlanCaptureMessage[]): LatestMarkedPlanInspection | null {
  let latestEndOnly: { text: string; messageId?: string } | undefined

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.info.role !== 'assistant') continue

    const text = messageText(message)
    const counts = countPlanMarkers(text)

    if (!latestEndOnly) {
      if (counts.startCount === 0 && counts.endCount === 1) {
        latestEndOnly = { text, messageId: message.info.id }
        continue
      }
      if (counts.startCount === 0 && counts.endCount === 0) continue
      return null
    }

    if (counts.startCount === 0 && counts.endCount === 0) continue

    if (counts.startCount === 1 && counts.endCount === 0) {
      const extraction = extractMarkedPlan(`${text}\n${latestEndOnly.text}`)
      if (extraction.ok) {
        return {
          status: 'found',
          planText: extraction.planText,
          messageId: latestEndOnly.messageId ?? message.info.id,
        }
      }

      return {
        status: 'invalid',
        reason: extraction.reason,
        messageId: latestEndOnly.messageId ?? message.info.id,
      }
    }

    return null
  }

  return null
}