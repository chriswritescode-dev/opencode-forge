export const PLAN_START_MARKER = '<!-- forge-plan:start -->'
export const PLAN_END_MARKER = '<!-- forge-plan:end -->'

export interface PlanCaptureMessage {
  info: { role?: string; id?: string; agent?: string }
  parts: Array<{ type: string; text?: string }>
}

export type MarkedPlanExtraction =
  | { ok: true; planText: string }
  | { ok: false; reason: 'missing' | 'multiple' | 'unterminated' | 'empty' }

export interface ExtractedPlanResult {
  planText: string
  messageId?: string
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

export function messageText(message: PlanCaptureMessage): string {
  const textParts = message.parts
    .filter((p) => p.type === 'text' && p.text !== undefined)
    .map((p) => p.text!)
  
  return textParts.join('\n')
}

export function extractLatestMarkedPlan(messages: PlanCaptureMessage[]): ExtractedPlanResult | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    
    if (message.info.role !== 'assistant') {
      continue
    }
    
    const text = messageText(message)
    const extraction = extractMarkedPlan(text)
    
    if (extraction.ok) {
      return {
        planText: extraction.planText,
        messageId: message.info.id,
      }
    }
    
    if (!extraction.ok && extraction.reason !== 'missing') {
      return null
    }
  }
  
  return null
}
