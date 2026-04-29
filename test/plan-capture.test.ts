import { describe, test, expect } from 'bun:test'
import {
  extractMarkedPlan,
  messageText,
  extractLatestMarkedPlan,
  PLAN_START_MARKER,
  PLAN_END_MARKER,
  type PlanCaptureMessage,
} from '../src/utils/plan-capture'
import { captureMarkedPlanTextForSession } from '../src/services/plan-capture'
import { createPlanCaptureEventHook } from '../src/hooks/plan-capture'

describe('extractMarkedPlan', () => {
  test('extracts plan body when markers are present', () => {
    const text = `Some intro text

${PLAN_START_MARKER}
# Implementation Plan

## Phase 1
- Do thing one

## Phase 2
- Do thing two
${PLAN_END_MARKER}

Some outro text`

    const result = extractMarkedPlan(text)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.planText).toContain('# Implementation Plan')
      expect(result.planText).not.toContain(PLAN_START_MARKER)
      expect(result.planText).not.toContain(PLAN_END_MARKER)
    }
  })

  test('returns missing when no markers exist', () => {
    const text = 'Just some plain text without markers'
    const result = extractMarkedPlan(text)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('missing')
    }
  })

  test('returns multiple when multiple start markers exist', () => {
    const text = `${PLAN_START_MARKER}
Plan A
${PLAN_END_MARKER}

${PLAN_START_MARKER}
Plan B
${PLAN_END_MARKER}`

    const result = extractMarkedPlan(text)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('multiple')
    }
  })

  test('returns multiple when multiple end markers exist', () => {
    const text = `${PLAN_START_MARKER}
Plan
${PLAN_END_MARKER}
${PLAN_END_MARKER}`

    const result = extractMarkedPlan(text)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('multiple')
    }
  })

  test('returns unterminated when only start marker exists', () => {
    const text = `${PLAN_START_MARKER}
Plan content without end`

    const result = extractMarkedPlan(text)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('unterminated')
    }
  })

  test('returns unterminated when only end marker exists', () => {
    const text = `Plan content
${PLAN_END_MARKER}`

    const result = extractMarkedPlan(text)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('unterminated')
    }
  })

  test('returns unterminated when end marker appears before start marker', () => {
    const text = `Some text
${PLAN_END_MARKER}
${PLAN_START_MARKER}
Plan
${PLAN_END_MARKER}`

    const result = extractMarkedPlan(text)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('multiple')
    }
  })

  test('returns empty when plan body is blank', () => {
    const text = `${PLAN_START_MARKER}

${PLAN_END_MARKER}`

    const result = extractMarkedPlan(text)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('empty')
    }
  })

  test('trims surrounding blank lines from plan body', () => {
    const text = `${PLAN_START_MARKER}

# Plan

Content

${PLAN_END_MARKER}`

    const result = extractMarkedPlan(text)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.planText).toBe('# Plan\n\nContent')
    }
  })

  test('requires markers on their own lines', () => {
    const text = `Some text ${PLAN_START_MARKER} more text`

    const result = extractMarkedPlan(text)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('missing')
    }
  })
})

describe('messageText', () => {
  test('joins text parts with newlines', () => {
    const message: PlanCaptureMessage = {
      info: { role: 'assistant' },
      parts: [
        { type: 'text', text: 'Line one' },
        { type: 'text', text: 'Line two' },
      ],
    }

    const result = messageText(message)
    expect(result).toBe('Line one\nLine two')
  })

  test('skips non-text parts', () => {
    const message: PlanCaptureMessage = {
      info: { role: 'assistant' },
      parts: [
        { type: 'text', text: 'Line one' },
        { type: 'image' as any, text: undefined },
        { type: 'text', text: 'Line two' },
      ],
    }

    const result = messageText(message)
    expect(result).toBe('Line one\nLine two')
  })

  test('returns empty string when no text parts', () => {
    const message: PlanCaptureMessage = {
      info: { role: 'assistant' },
      parts: [{ type: 'image' as any }],
    }

    const result = messageText(message)
    expect(result).toBe('')
  })
})

describe('extractLatestMarkedPlan', () => {
  test('finds the newest assistant message with a valid plan', () => {
    const messages: PlanCaptureMessage[] = [
      {
        info: { role: 'user', id: 'msg-1' },
        parts: [{ type: 'text', text: 'User message' }],
      },
      {
        info: { role: 'assistant', id: 'msg-2' },
        parts: [{ type: 'text', text: `Old plan\n${PLAN_START_MARKER}\nOld Plan\n${PLAN_END_MARKER}` }],
      },
      {
        info: { role: 'assistant', id: 'msg-3' },
        parts: [{ type: 'text', text: `New plan\n${PLAN_START_MARKER}\nNew Plan\n${PLAN_END_MARKER}` }],
      },
    ]

    const result = extractLatestMarkedPlan(messages)
    expect(result).not.toBeNull()
    if (result) {
      expect(result.planText).toBe('New Plan')
      expect(result.messageId).toBe('msg-3')
    }
  })

  test('skips user messages', () => {
    const messages: PlanCaptureMessage[] = [
      {
        info: { role: 'assistant', id: 'msg-1' },
        parts: [{ type: 'text', text: `${PLAN_START_MARKER}\nOld\n${PLAN_END_MARKER}` }],
      },
      {
        info: { role: 'user', id: 'msg-2' },
        parts: [{ type: 'text', text: `${PLAN_START_MARKER}\nNewer\n${PLAN_END_MARKER}` }],
      },
    ]

    const result = extractLatestMarkedPlan(messages)
    expect(result).not.toBeNull()
    if (result) {
      expect(result.planText).toBe('Old')
    }
  })

  test('returns null when newest assistant has invalid markers', () => {
    const messages: PlanCaptureMessage[] = [
      {
        info: { role: 'assistant', id: 'msg-1' },
        parts: [{ type: 'text', text: `${PLAN_START_MARKER}\nOld Plan\n${PLAN_END_MARKER}` }],
      },
      {
        info: { role: 'assistant', id: 'msg-2' },
        parts: [{ type: 'text', text: `${PLAN_START_MARKER}\nUnterminated` }],
      },
    ]

    const result = extractLatestMarkedPlan(messages)
    expect(result).toBeNull()
  })

  test('returns null when no assistant messages have plans', () => {
    const messages: PlanCaptureMessage[] = [
      {
        info: { role: 'assistant', id: 'msg-1' },
        parts: [{ type: 'text', text: 'Just text, no markers' }],
      },
    ]

    const result = extractLatestMarkedPlan(messages)
    expect(result).toBeNull()
  })

  test('returns null when messages array is empty', () => {
    const messages: PlanCaptureMessage[] = []
    const result = extractLatestMarkedPlan(messages)
    expect(result).toBeNull()
  })
})

describe('marked plan persistence', () => {
  function createFakePlansRepo() {
    const plans = new Map<string, { content: string; updatedAt: number }>()
    return {
      writeForSession: (_projectId: string, sessionId: string, content: string) => {
        plans.set(sessionId, { content, updatedAt: Date.now() })
      },
      getForSession: (_projectId: string, sessionId: string) => {
        const row = plans.get(sessionId)
        if (!row) return null
        return { projectId: 'test-project', loopName: null, sessionId, content: row.content, updatedAt: row.updatedAt }
      },
    }
  }

  const logger = {
    log: () => {},
    error: () => {},
    debug: () => {},
  }

  test('persists only the plan body from a completed marked text part', () => {
    const plansRepo = createFakePlansRepo()
    const text = `Intro
${PLAN_START_MARKER}

# Captured Plan

## Verification
- bun test test/plan-capture.test.ts

${PLAN_END_MARKER}
Outro`

    const result = captureMarkedPlanTextForSession(
      { plansRepo: plansRepo as any, projectId: 'test-project', logger },
      'session-1',
      text,
      'message-1'
    )

    expect(result.status).toBe('captured')
    expect(plansRepo.getForSession('test-project', 'session-1')?.content).toBe('# Captured Plan\n\n## Verification\n- bun test test/plan-capture.test.ts')
  })

  test('message part event auto-captures before idle or approval', async () => {
    const plansRepo = createFakePlansRepo()
    const hook = createPlanCaptureEventHook({
      v2: { session: { messages: async () => ({ data: [] }) } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    } as any)

    await hook({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-2',
          part: {
            type: 'text',
            messageID: 'message-2',
            text: `${PLAN_START_MARKER}\n# Event Plan`,
          },
        },
      },
    })

    expect(plansRepo.getForSession('test-project', 'session-2')).toBeNull()

    await hook({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-2',
          part: {
            type: 'text',
            messageID: 'message-2',
            text: `${PLAN_START_MARKER}\n# Event Plan\n\n## Verification\n- pnpm typecheck\n${PLAN_END_MARKER}`,
          },
        },
      },
    })

    expect(plansRepo.getForSession('test-project', 'session-2')?.content).toBe('# Event Plan\n\n## Verification\n- pnpm typecheck')
  })
})
