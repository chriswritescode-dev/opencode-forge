import { computeFenceMask } from './markdown-fences'

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

export type PastedPlanNormalization =
  | { ok: true; planText: string; source: 'marked' | 'unmarked' }
  | { ok: false; reason: 'empty' | 'multiple' | 'unterminated' }

function countPlanMarkers(text: string): { startCount: number; endCount: number } {
  const lines = text.split('\n')
  const mask = computeFenceMask(lines)
  let startCount = 0
  let endCount = 0
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue
    const line = lines[i].trim()
    if (line === PLAN_START_MARKER) startCount++
    if (line === PLAN_END_MARKER) endCount++
  }
  return { startCount, endCount }
}

export function extractMarkedPlan(text: string): MarkedPlanExtraction {
  const lines = text.split('\n')
  const mask = computeFenceMask(lines)

  const unmaskedStarts: number[] = []
  const unmaskedEnds: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue
    const line = lines[i].trim()
    if (line === PLAN_START_MARKER) unmaskedStarts.push(i)
    if (line === PLAN_END_MARKER) unmaskedEnds.push(i)
  }

  if (unmaskedStarts.length === 0 && unmaskedEnds.length === 0) {
    return { ok: false, reason: 'missing' }
  }

  if (unmaskedStarts.length > 1 || unmaskedEnds.length > 1) {
    return { ok: false, reason: 'multiple' }
  }

  if (unmaskedStarts.length === 1 && unmaskedEnds.length === 0) {
    // Fallback (deliberate asymmetry): an unbalanced fence inside the plan
    // body must not be able to swallow plan termination, and the split-message
    // repair path in inspectLatestPlanCompletedByLaterEndMarker depends on it.
    // Search for the first line after startIndex whose trimmed form equals the
    // end marker, ignoring the fence mask.
    const startIndex = unmaskedStarts[0]
    let endIndex = -1
    for (let j = startIndex + 1; j < lines.length; j++) {
      if (lines[j].trim() === PLAN_END_MARKER) {
        endIndex = j
        break
      }
    }
    if (endIndex === -1) {
      return { ok: false, reason: 'unterminated' }
    }
    const planText = lines.slice(startIndex + 1, endIndex).join('\n').trim()
    if (planText.length === 0) {
      return { ok: false, reason: 'empty' }
    }
    return { ok: true, planText }
  }

  if (unmaskedStarts.length === 0 && unmaskedEnds.length === 1) {
    return { ok: false, reason: 'unterminated' }
  }

  const startIndex = unmaskedStarts[0]
  const endIndex = unmaskedEnds[0]

  if (endIndex <= startIndex) {
    return { ok: false, reason: 'unterminated' }
  }

  const planText = lines.slice(startIndex + 1, endIndex).join('\n').trim()

  if (planText.length === 0) {
    return { ok: false, reason: 'empty' }
  }

  return { ok: true, planText }
}

export function normalizePastedPlanText(text: string): PastedPlanNormalization {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, reason: 'empty' }

  const extraction = extractMarkedPlan(trimmed)
  if (extraction.ok) {
    return { ok: true, planText: extraction.planText, source: 'marked' }
  }

  if (extraction.reason === 'missing') {
    return { ok: true, planText: trimmed, source: 'unmarked' }
  }

  return { ok: false, reason: extraction.reason }
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