import { computeFenceMask } from './markdown-fences'

export const PLAN_START_MARKER = '<!-- forge-plan:start -->'
export const PLAN_END_MARKER = '<!-- forge-plan:end -->'

/**
 * Number of recent messages any marked-plan scan inspects. Shared by the
 * server's capture paths and the TUI's plan fetch so both see the same window.
 */
export const PLAN_CAPTURE_MESSAGE_LIMIT = 20

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

interface PlanMarkerScan {
  lines: string[]
  /** Line indices of unfenced plan start markers. */
  starts: number[]
  /** Line indices of unfenced plan end markers. */
  ends: number[]
}

/**
 * The single unfenced plan-marker scan. `hasPlanMarker` short-circuits the
 * common marker-free message: without either marker there is nothing to find,
 * so the line split and fence mask are pure waste. Every marked-plan capture
 * runs on each assistant message completion, so that guard is load-bearing.
 */
function hasPlanMarker(text: string): boolean {
  return text.includes(PLAN_START_MARKER) || text.includes(PLAN_END_MARKER)
}

function scanPlanMarkers(text: string): PlanMarkerScan {
  if (!hasPlanMarker(text)) return { lines: [], starts: [], ends: [] }

  const lines = text.split('\n')
  const mask = computeFenceMask(lines)
  const starts: number[] = []
  const ends: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue
    const line = lines[i].trim()
    if (line === PLAN_START_MARKER) starts.push(i)
    else if (line === PLAN_END_MARKER) ends.push(i)
  }
  return { lines, starts, ends }
}

function countPlanMarkers(text: string): { startCount: number; endCount: number } {
  const { starts, ends } = scanPlanMarkers(text)
  return { startCount: starts.length, endCount: ends.length }
}

/** Trims the plan body between two marker lines, rejecting an empty result. */
function planBodyBetween(lines: string[], startIndex: number, endIndex: number): MarkedPlanExtraction {
  const planText = lines.slice(startIndex + 1, endIndex).join('\n').trim()
  if (planText.length === 0) {
    return { ok: false, reason: 'empty' }
  }
  return { ok: true, planText }
}

export function extractMarkedPlan(text: string): MarkedPlanExtraction {
  const { lines, starts: unmaskedStarts, ends: unmaskedEnds } = scanPlanMarkers(text)

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
    return planBodyBetween(lines, startIndex, endIndex)
  }

  if (unmaskedStarts.length === 0 && unmaskedEnds.length === 1) {
    return { ok: false, reason: 'unterminated' }
  }

  const startIndex = unmaskedStarts[0]
  const endIndex = unmaskedEnds[0]

  if (endIndex <= startIndex) {
    return { ok: false, reason: 'unterminated' }
  }

  return planBodyBetween(lines, startIndex, endIndex)
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

interface AssistantMessageText {
  text: string
  messageId?: string
}

export function inspectLatestMarkedPlan(messages: PlanCaptureMessage[]): LatestMarkedPlanInspection {
  // Flatten each assistant message's text once. Both passes below walk the same
  // messages, and the split-message repair pass falls through all of them
  // whenever no plan is present, which is the common case.
  const assistant: AssistantMessageText[] = []
  for (const message of messages) {
    if (message.info.role !== 'assistant') continue
    assistant.push({ text: messageText(message), messageId: message.info.id })
  }

  const repaired = inspectLatestPlanCompletedByLaterEndMarker(assistant)
  if (repaired) return repaired

  for (let i = assistant.length - 1; i >= 0; i--) {
    const { text, messageId } = assistant[i]
    const extraction = extractMarkedPlan(text)

    if (extraction.ok) {
      return { status: 'found', planText: extraction.planText, messageId }
    }

    if (extraction.reason !== 'missing') {
      return { status: 'invalid', reason: extraction.reason, messageId }
    }
  }

  return { status: 'missing' }
}

function inspectLatestPlanCompletedByLaterEndMarker(
  messages: AssistantMessageText[]
): LatestMarkedPlanInspection | null {
  let latestEndOnly: AssistantMessageText | undefined

  for (let i = messages.length - 1; i >= 0; i--) {
    const { text, messageId } = messages[i]
    const counts = countPlanMarkers(text)

    if (!latestEndOnly) {
      if (counts.startCount === 0 && counts.endCount === 1) {
        latestEndOnly = { text, messageId }
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
          messageId: latestEndOnly.messageId ?? messageId,
        }
      }

      return {
        status: 'invalid',
        reason: extraction.reason,
        messageId: latestEndOnly.messageId ?? messageId,
      }
    }

    return null
  }

  return null
}