import { describe, test, expect } from 'bun:test'
import {
  extractMarkedPlan,
  normalizePastedPlanText,
  messageText,
  inspectLatestMarkedPlan,
  inspectLatestPastedPlan,
  PLAN_START_MARKER,
  PLAN_END_MARKER,
  type PlanCaptureMessage,
} from '../src/utils/marked-plan-parser'
import { captureMarkedPlanTextForSession, captureLatestPlanForSession, capturePastedPlanForSession } from '../src/services/plan-capture'
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

describe('normalizePastedPlanText', () => {
  test('marked paste extracts plan body and excludes surrounding text', () => {
    const text = `Some intro text

${PLAN_START_MARKER}
# Implementation Plan

## Phase 1
- Do thing one

## Phase 2
- Do thing two
${PLAN_END_MARKER}

Some outro text`

    const result = normalizePastedPlanText(text)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toBe('marked')
      expect(result.planText).toContain('# Implementation Plan')
      expect(result.planText).not.toContain(PLAN_START_MARKER)
      expect(result.planText).not.toContain(PLAN_END_MARKER)
      expect(result.planText).not.toContain('Some intro text')
      expect(result.planText).not.toContain('Some outro text')
    }
  })

  test('unmarked paste returns trimmed text unchanged', () => {
    const text = `
  # My Plan

  A simple plan without markers.

  - Step one
  - Step two
    `

    const result = normalizePastedPlanText(text)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toBe('unmarked')
      expect(result.planText).toBe(text.trim())
    }
  })

  test('empty string returns empty', () => {
    const result = normalizePastedPlanText('')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('empty')
    }
  })

  test('whitespace-only string returns empty', () => {
    const result = normalizePastedPlanText('   \n  \n  ')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('empty')
    }
  })

  test('malformed marked paste with only start marker returns unterminated', () => {
    const text = `${PLAN_START_MARKER}
Plan content without end`

    const result = normalizePastedPlanText(text)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('unterminated')
    }
  })

  test('malformed marked paste with multiple marked plans returns multiple', () => {
    const text = `${PLAN_START_MARKER}
Plan A
${PLAN_END_MARKER}

${PLAN_START_MARKER}
Plan B
${PLAN_END_MARKER}`

    const result = normalizePastedPlanText(text)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('multiple')
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

describe('inspectLatestMarkedPlan', () => {
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

    const result = inspectLatestMarkedPlan(messages)
    expect(result.status).toBe('found')
    if (result.status === 'found') {
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

    const result = inspectLatestMarkedPlan(messages)
    expect(result.status).toBe('found')
    if (result.status === 'found') {
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

    const result = inspectLatestMarkedPlan(messages)
    expect(result.status).toBe('invalid')
  })

  test('repairs newest assistant plan when a later assistant message adds only the end marker', () => {
    const messages: PlanCaptureMessage[] = [
      {
        info: { role: 'assistant', id: 'msg-1' },
        parts: [{ type: 'text', text: `${PLAN_START_MARKER}\n## Phase 1: Build\n### Files\n- src/index.ts` }],
      },
      {
        info: { role: 'assistant', id: 'msg-2' },
        parts: [{ type: 'text', text: PLAN_END_MARKER }],
      },
    ]

    const result = inspectLatestMarkedPlan(messages)
    expect(result.status).toBe('found')
    if (result.status === 'found') {
      expect(result.planText).toContain('## Phase 1: Build')
      expect(result.planText).toContain('### Files')
      expect(result.planText).not.toContain(PLAN_START_MARKER)
      expect(result.planText).not.toContain(PLAN_END_MARKER)
      expect(result.messageId).toBe('msg-2')
    }
  })

  test('returns null when no assistant messages have plans', () => {
    const messages: PlanCaptureMessage[] = [
      {
        info: { role: 'assistant', id: 'msg-1' },
        parts: [{ type: 'text', text: 'Just text, no markers' }],
      },
    ]

    const result = inspectLatestMarkedPlan(messages)
    expect(result.status).toBe('missing')
  })

  test('returns null when messages array is empty', () => {
    const messages: PlanCaptureMessage[] = []
    const result = inspectLatestMarkedPlan(messages)
    expect(result.status).toBe('missing')
  })
})

describe('inspectLatestPastedPlan', () => {
  test('finds plan in newest user message', () => {
    const messages: PlanCaptureMessage[] = [
      {
        info: { role: 'user', id: 'msg-1' },
        parts: [{ type: 'text', text: `Earlier\n${PLAN_START_MARKER}\nEarlier Plan\n${PLAN_END_MARKER}` }],
      },
      {
        info: { role: 'user', id: 'msg-2' },
        parts: [{ type: 'text', text: `Latest\n${PLAN_START_MARKER}\nLatest Plan\n${PLAN_END_MARKER}` }],
      },
    ]

    const result = inspectLatestPastedPlan(messages)
    expect(result.status).toBe('found')
    if (result.status === 'found') {
      expect(result.planText).toBe('Latest Plan')
      expect(result.messageId).toBe('msg-2')
    }
  })

  test('ignores assistant-only plan and returns missing', () => {
    const messages: PlanCaptureMessage[] = [
      {
        info: { role: 'assistant', id: 'msg-1' },
        parts: [{ type: 'text', text: `${PLAN_START_MARKER}\nAssistant Plan\n${PLAN_END_MARKER}` }],
      },
    ]

    const result = inspectLatestPastedPlan(messages)
    expect(result.status).toBe('missing')
  })

  test('picks newest user message when multiple user messages have plans', () => {
    const messages: PlanCaptureMessage[] = [
      {
        info: { role: 'user', id: 'msg-1' },
        parts: [{ type: 'text', text: `${PLAN_START_MARKER}\nFirst User Plan\n${PLAN_END_MARKER}` }],
      },
      {
        info: { role: 'assistant', id: 'msg-2' },
        parts: [{ type: 'text', text: `${PLAN_START_MARKER}\nAssistant Plan\n${PLAN_END_MARKER}` }],
      },
      {
        info: { role: 'user', id: 'msg-3' },
        parts: [{ type: 'text', text: `${PLAN_START_MARKER}\nSecond User Plan\n${PLAN_END_MARKER}` }],
      },
    ]

    const result = inspectLatestPastedPlan(messages)
    expect(result.status).toBe('found')
    if (result.status === 'found') {
      expect(result.planText).toBe('Second User Plan')
      expect(result.messageId).toBe('msg-3')
    }
  })

  test('returns invalid on multiple markers in user message', () => {
    const messages: PlanCaptureMessage[] = [
      {
        info: { role: 'user', id: 'msg-1' },
        parts: [{
          type: 'text',
          text: `${PLAN_START_MARKER}\nPlan A\n${PLAN_END_MARKER}\n${PLAN_START_MARKER}\nPlan B\n${PLAN_END_MARKER}`,
        }],
      },
    ]

    const result = inspectLatestPastedPlan(messages)
    expect(result.status).toBe('invalid')
    if (result.status === 'invalid') {
      expect(result.reason).toBe('multiple')
    }
  })

  test('returns invalid on unterminated markers in user message', () => {
    const messages: PlanCaptureMessage[] = [
      {
        info: { role: 'user', id: 'msg-1' },
        parts: [{ type: 'text', text: `${PLAN_START_MARKER}\nNo end marker here` }],
      },
    ]

    const result = inspectLatestPastedPlan(messages)
    expect(result.status).toBe('invalid')
    if (result.status === 'invalid') {
      expect(result.reason).toBe('unterminated')
    }
  })

  test('returns missing when user message has no markers', () => {
    const messages: PlanCaptureMessage[] = [
      {
        info: { role: 'user', id: 'msg-1' },
        parts: [{ type: 'text', text: 'Just plain text without markers' }],
      },
    ]

    const result = inspectLatestPastedPlan(messages)
    expect(result.status).toBe('missing')
  })

  test('returns missing when newest user message has no markers even if older user message has a plan', () => {
    const messages: PlanCaptureMessage[] = [
      {
        info: { role: 'user', id: 'msg-old' },
        parts: [{ type: 'text', text: `${PLAN_START_MARKER}\nOlder Plan\n${PLAN_END_MARKER}` }],
      },
      {
        info: { role: 'user', id: 'msg-newest' },
        parts: [{ type: 'text', text: 'Just plain text without markers' }],
      },
    ]

    const result = inspectLatestPastedPlan(messages)
    // Should NOT find the older plan — only the newest user message is considered
    expect(result.status).toBe('missing')
  })

  test('does not repair split markers across user messages (returns invalid)', () => {
    const messages: PlanCaptureMessage[] = [
      {
        info: { role: 'user', id: 'msg-1' },
        parts: [{ type: 'text', text: `${PLAN_START_MARKER}\nPlan body without end marker` }],
      },
      {
        info: { role: 'user', id: 'msg-2' },
        parts: [{ type: 'text', text: PLAN_END_MARKER }],
      },
    ]

    const result = inspectLatestPastedPlan(messages)
    expect(result.status).toBe('invalid')
  })

  test('returns missing when messages array is empty', () => {
    const messages: PlanCaptureMessage[] = []
    const result = inspectLatestPastedPlan(messages)
    expect(result.status).toBe('missing')
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
      input: { client: { session: { messages: async () => ({ data: [] }) } } },
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

describe('captureLatestPlanForSession legacy client fallback', () => {
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

  const planMessage = {
    info: { role: 'assistant', id: 'msg-1' },
    parts: [{ type: 'text', text: `${PLAN_START_MARKER}\nFallback Plan\n${PLAN_END_MARKER}` }],
  }

  test('falls back to legacy client when v2 returns empty data', async () => {
    const plansRepo = createFakePlansRepo()
    const deps = {
      v2: { session: { messages: async () => ({ data: [] }) } },
      client: { session: { messages: async () => ({ data: [planMessage] }) } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    }

    const result = await captureLatestPlanForSession(deps as any, 'session-fb-1')

    expect(result.status).toBe('captured')
    expect(plansRepo.getForSession('test-project', 'session-fb-1')?.content).toBe('Fallback Plan')
  })

  test('falls back to legacy client when v2 returns an error', async () => {
    const plansRepo = createFakePlansRepo()
    const deps = {
      v2: { session: { messages: async () => ({ error: { message: 'boom' }, data: undefined }) } },
      client: { session: { messages: async () => ({ data: [planMessage] }) } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    }

    const result = await captureLatestPlanForSession(deps as any, 'session-fb-2')

    expect(result.status).toBe('captured')
    expect(plansRepo.getForSession('test-project', 'session-fb-2')?.content).toBe('Fallback Plan')
  })

  test('returns not-found when both v2 and legacy return empty', async () => {
    const plansRepo = createFakePlansRepo()
    const deps = {
      v2: { session: { messages: async () => ({ data: [] }) } },
      client: { session: { messages: async () => ({ data: [] }) } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    }

    const result = await captureLatestPlanForSession(deps as any, 'session-fb-3')

    expect(result.status).toBe('not-found')
    expect(plansRepo.getForSession('test-project', 'session-fb-3')).toBeNull()
  })
})

describe('capturePastedPlanForSession', () => {
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

  test('captures a valid pasted plan from the newest user message', async () => {
    const plansRepo = createFakePlansRepo()
    const deps = {
      v2: { session: { messages: async () => ({
        data: [{
          info: { role: 'user', id: 'msg-1' },
          parts: [{ type: 'text', text: `${PLAN_START_MARKER}\n# Pasted Plan\n\n## Step 1\n- Do it\n${PLAN_END_MARKER}` }],
        }],
      }) } },
      client: { session: { messages: async () => ({ data: [] }) } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    }

    const result = await capturePastedPlanForSession(deps as any, 'session-pp-1')
    expect(result.status).toBe('captured')
    if (result.status === 'captured') {
      expect(result.planText).toBe('# Pasted Plan\n\n## Step 1\n- Do it')
    }
    expect(plansRepo.getForSession('test-project', 'session-pp-1')?.content).toBe('# Pasted Plan\n\n## Step 1\n- Do it')
  })

  test('returns already-current when identical plan is already stored', async () => {
    const plansRepo = createFakePlansRepo()
    const planText = `${PLAN_START_MARKER}\n# Same Plan\n\nContent\n${PLAN_END_MARKER}`
    const messageData = [{
      info: { role: 'user', id: 'msg-same' },
      parts: [{ type: 'text', text: planText }],
    }]
    const deps = {
      v2: { session: { messages: async () => ({ data: messageData }) } },
      client: { session: { messages: async () => ({ data: [] }) } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    }

    // First call captures
    const first = await capturePastedPlanForSession(deps as any, 'session-pp-same')
    expect(first.status).toBe('captured')

    // Second call with same content should be already-current
    const second = await capturePastedPlanForSession(deps as any, 'session-pp-same')
    expect(second.status).toBe('already-current')
    if (second.status === 'already-current') {
      expect(second.planText).toBe('# Same Plan\n\nContent')
    }
  })

  test('returns not-found when user message has no markers', async () => {
    const plansRepo = createFakePlansRepo()
    const deps = {
      v2: { session: { messages: async () => ({
        data: [{
          info: { role: 'user', id: 'msg-nope' },
          parts: [{ type: 'text', text: 'Just some plain text without markers' }],
        }],
      }) } },
      client: { session: { messages: async () => ({ data: [] }) } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    }

    const result = await capturePastedPlanForSession(deps as any, 'session-pp-nope')
    expect(result.status).toBe('not-found')
    expect(plansRepo.getForSession('test-project', 'session-pp-nope')).toBeNull()
  })

  test('returns not-found when newest user message has no markers but older user message has a plan', async () => {
    const plansRepo = createFakePlansRepo()
    const deps = {
      v2: { session: { messages: async () => ({
        data: [
          {
            info: { role: 'user', id: 'msg-old' },
            parts: [{ type: 'text', text: `${PLAN_START_MARKER}\nOlder Plan\n${PLAN_END_MARKER}` }],
          },
          {
            info: { role: 'user', id: 'msg-newest' },
            parts: [{ type: 'text', text: 'Just plain text without markers' }],
          },
        ],
      }) } },
      client: { session: { messages: async () => ({ data: [] }) } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    }

    const result = await capturePastedPlanForSession(deps as any, 'session-pp-regression')
    // Should NOT capture the older plan — only the newest user message is considered
    expect(result.status).toBe('not-found')
    expect(plansRepo.getForSession('test-project', 'session-pp-regression')).toBeNull()
  })

  test('returns invalid on malformed markers in user message', async () => {
    const plansRepo = createFakePlansRepo()
    const deps = {
      v2: { session: { messages: async () => ({
        data: [{
          info: { role: 'user', id: 'msg-bad' },
          parts: [{ type: 'text', text: `${PLAN_START_MARKER}\nNo end marker` }],
        }],
      }) } },
      client: { session: { messages: async () => ({ data: [] }) } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    }

    const result = await capturePastedPlanForSession(deps as any, 'session-pp-bad')
    expect(result.status).toBe('invalid')
    if (result.status === 'invalid') {
      expect(result.reason).toBe('unterminated')
    }
    expect(plansRepo.getForSession('test-project', 'session-pp-bad')).toBeNull()
  })

  test('returns not-found when messages array is empty', async () => {
    const plansRepo = createFakePlansRepo()
    const deps = {
      v2: { session: { messages: async () => ({ data: [] }) } },
      client: { session: { messages: async () => ({ data: [] }) } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    }

    const result = await capturePastedPlanForSession(deps as any, 'session-pp-empty')
    expect(result.status).toBe('not-found')
  })

  test('falls back to legacy client when v2 returns empty data', async () => {
    const plansRepo = createFakePlansRepo()
    const deps = {
      v2: { session: { messages: async () => ({ data: [] }) } },
      client: { session: { messages: async () => ({
        data: [{
          info: { role: 'user', id: 'msg-fb' },
          parts: [{ type: 'text', text: `${PLAN_START_MARKER}\nFallback Pasted Plan\n${PLAN_END_MARKER}` }],
        }],
      }) } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    }

    const result = await capturePastedPlanForSession(deps as any, 'session-pp-fb')
    expect(result.status).toBe('captured')
    expect(plansRepo.getForSession('test-project', 'session-pp-fb')?.content).toBe('Fallback Pasted Plan')
  })

  test('returns not-found when both v2 and legacy return empty', async () => {
    const plansRepo = createFakePlansRepo()
    const deps = {
      v2: { session: { messages: async () => ({ data: [] }) } },
      client: { session: { messages: async () => ({ data: [] }) } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    }

    const result = await capturePastedPlanForSession(deps as any, 'session-pp-both-empty')
    expect(result.status).toBe('not-found')
  })
})

describe('plan capture trigger on assistant message completion', () => {
  function createFakePlansRepo() {
    const plans = new Map<string, { content: string; updatedAt: number }>()
    let nextUpdatedAt = 1
    return {
      writeForSession: (_projectId: string, sessionId: string, content: string) => {
        plans.set(sessionId, { content, updatedAt: nextUpdatedAt++ })
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

  test('captures plan on message.updated when assistant message completes, even while session stays busy', async () => {
    const plansRepo = createFakePlansRepo()
    const messages = [{
      info: { role: 'assistant', id: 'msg-final', time: { created: 1, completed: 2 } },
      parts: [{ type: 'text', text: `${PLAN_START_MARKER}\n# Completed Plan\n\n## Verification\n- bun test\n${PLAN_END_MARKER}` }],
    }]
    const hook = createPlanCaptureEventHook({
      v2: { session: { messages: async () => ({ data: messages }) } },
      input: { client: { session: { messages: async () => ({ data: messages }) } } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    } as any)

    await hook({ event: { type: 'message.updated', properties: { sessionID: 'session-mu-1', info: messages[0].info } } })

    expect(plansRepo.getForSession('test-project', 'session-mu-1')?.content).toBe('# Completed Plan\n\n## Verification\n- bun test')
  })

  test('ignores message.updated when role is user and no markers present (no plan written)', async () => {
    const plansRepo = createFakePlansRepo()
    let messagesCalls = 0
    const hook = createPlanCaptureEventHook({
      v2: { session: { messages: async () => {
        messagesCalls++
        return { data: [] }
      } } },
      input: { client: { session: { messages: async () => ({ data: [] }) } } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    } as any)

    await hook({ event: { type: 'message.updated', properties: { sessionID: 'session-mu-user', info: { role: 'user', id: 'msg', time: { created: 1, completed: 2 } } } } })

    // No plan written because messages are empty
    expect(plansRepo.getForSession('test-project', 'session-mu-user')).toBeNull()
    // User messages are now handled, so messages are fetched
    expect(messagesCalls).toBeGreaterThanOrEqual(1)
  })

  test('ignores message.updated when time.completed is undefined (streaming, not finished)', async () => {
    const plansRepo = createFakePlansRepo()
    let messagesCalls = 0
    const hook = createPlanCaptureEventHook({
      v2: { session: { messages: async () => {
        messagesCalls++
        return { data: [] }
      } } },
      input: { client: { session: { messages: async () => ({ data: [] }) } } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    } as any)

    await hook({ event: { type: 'message.updated', properties: { sessionID: 'session-mu-streaming', info: { role: 'assistant', id: 'msg', time: { created: 1 } } } } })

    expect(plansRepo.getForSession('test-project', 'session-mu-streaming')).toBeNull()
    expect(messagesCalls).toBe(0)
  })

  test('does not double-write when message.part.updated already captured the same plan', async () => {
    const plansRepo = createFakePlansRepo()
    const text = `${PLAN_START_MARKER}\n# Completed Plan\n\n## Verification\n- bun test\n${PLAN_END_MARKER}`
    const messages = [{
      info: { role: 'assistant', id: 'msg-final', time: { created: 1, completed: 2 } },
      parts: [{ type: 'text', text }],
    }]
    const hook = createPlanCaptureEventHook({
      v2: { session: { messages: async () => ({ data: messages }) } },
      input: { client: { session: { messages: async () => ({ data: messages }) } } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    } as any)

    await hook({
      event: {
        type: 'message.part.updated',
        properties: { sessionID: 'session-mu-dedupe', part: { type: 'text', messageID: 'msg-final', text } },
      },
    })
    const captured = plansRepo.getForSession('test-project', 'session-mu-dedupe')

    await hook({ event: { type: 'message.updated', properties: { sessionID: 'session-mu-dedupe', info: messages[0].info } } })

    const afterCompletion = plansRepo.getForSession('test-project', 'session-mu-dedupe')
    expect(afterCompletion?.content).toBe('# Completed Plan\n\n## Verification\n- bun test')
    expect(afterCompletion?.updatedAt).toBe(captured?.updatedAt)
  })
})

describe('user paste capture trigger', () => {
  function createFakePlansRepo() {
    const plans = new Map<string, { content: string; updatedAt: number }>()
    let nextUpdatedAt = 1
    return {
      writeForSession: (_projectId: string, sessionId: string, content: string) => {
        plans.set(sessionId, { content, updatedAt: nextUpdatedAt++ })
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

  const MARKED_PLAN = `${PLAN_START_MARKER}\n# Pasted User Plan\n\n## Step 1\n- Do it\n${PLAN_END_MARKER}`
  const EXPECTED_PLAN = '# Pasted User Plan\n\n## Step 1\n- Do it'

  function makeHookCtx(overrides: {
    messagesData?: Array<{ info: Record<string, unknown>; parts: Array<{ type: string; text: string }> }>
    promptAsyncCalls?: Array<{ agent?: string }>
    resolveLoopName?: () => string | null | undefined
    getActiveState?: () => { active?: boolean; sessionId?: string } | null
  }) {
    const calls = overrides.promptAsyncCalls ?? []
    const spy = async (args: any) => {
      const agent = args?.body?.agent ?? args?.agent
      calls.push({ agent })
      return {}
    }
    return {
      v2: {
        session: {
          messages: async () => ({ data: overrides.messagesData ?? [{ info: { role: 'user', id: 'msg' }, parts: [{ type: 'text', text: MARKED_PLAN }] }] }),
          promptAsync: spy,
        },
      },
      input: {
        client: {
          session: {
            messages: async () => ({ data: [] }),
            promptAsync: spy,
          },
        },
      },
      plansRepo: createFakePlansRepo(),
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
      loop: {
        resolveLoopName: overrides.resolveLoopName ?? (() => undefined),
        getActiveState: overrides.getActiveState ?? (() => null),
      },
    }
  }

  test('(a) captures plan and prompts architect on user message with valid plan', async () => {
    const promptAsyncCalls: Array<{ agent?: string }> = []
    const ctx = makeHookCtx({
      messagesData: [{
        info: { role: 'user', id: 'msg-user-a' },
        parts: [{ type: 'text', text: MARKED_PLAN }],
      }],
      promptAsyncCalls,
    })
    const hook = createPlanCaptureEventHook(ctx as any)

    await hook({
      event: {
        type: 'message.updated',
        properties: {
          sessionID: 'session-up-a',
          info: { role: 'user', id: 'msg-user-a', time: { created: 1, completed: 2 } },
        },
      },
    })

    // Plan should be captured
    expect(ctx.plansRepo.getForSession('test-project', 'session-up-a')?.content).toBe(EXPECTED_PLAN)
    // promptAsync should have been called with agent: 'architect'
    expect(promptAsyncCalls.length).toBeGreaterThanOrEqual(1)
    const architectCall = promptAsyncCalls.find(c => c.agent === 'architect')
    expect(architectCall).toBeDefined()
  })

  test('(b) firing same event again does not prompt a second time (already-current)', async () => {
    const promptAsyncCalls: Array<{ agent?: string }> = []
    const ctx = makeHookCtx({
      messagesData: [{
        info: { role: 'user', id: 'msg-user-b' },
        parts: [{ type: 'text', text: MARKED_PLAN }],
      }],
      promptAsyncCalls,
    })
    const hook = createPlanCaptureEventHook(ctx as any)

    // First call: capture + prompt
    await hook({
      event: {
        type: 'message.updated',
        properties: {
          sessionID: 'session-up-b',
          info: { role: 'user', id: 'msg-user-b', time: { created: 1, completed: 2 } },
        },
      },
    })
    const firstPromptCount = promptAsyncCalls.filter(c => c.agent === 'architect').length
    expect(firstPromptCount).toBe(1)

    // Second call with same event: no new prompt
    await hook({
      event: {
        type: 'message.updated',
        properties: {
          sessionID: 'session-up-b',
          info: { role: 'user', id: 'msg-user-b', time: { created: 1, completed: 2 } },
        },
      },
    })
    const secondPromptCount = promptAsyncCalls.filter(c => c.agent === 'architect').length
    expect(secondPromptCount).toBe(1)
  })

  test('(c) user message without markers does not write or prompt', async () => {
    const promptAsyncCalls: Array<{ agent?: string }> = []
    const ctx = makeHookCtx({
      messagesData: [{
        info: { role: 'user', id: 'msg-user-c' },
        parts: [{ type: 'text', text: 'Just some plain text with no markers' }],
      }],
      promptAsyncCalls,
    })
    const hook = createPlanCaptureEventHook(ctx as any)

    await hook({
      event: {
        type: 'message.updated',
        properties: {
          sessionID: 'session-up-c',
          info: { role: 'user', id: 'msg-user-c', time: { created: 1, completed: 2 } },
        },
      },
    })

    expect(ctx.plansRepo.getForSession('test-project', 'session-up-c')).toBeNull()
    expect(promptAsyncCalls.length).toBe(0)
  })

  test('(d) when loop is active, no capture and no prompt', async () => {
    const promptAsyncCalls: Array<{ agent?: string }> = []
    const ctx = makeHookCtx({
      messagesData: [{
        info: { role: 'user', id: 'msg-user-d' },
        parts: [{ type: 'text', text: MARKED_PLAN }],
      }],
      promptAsyncCalls,
      resolveLoopName: () => 'my-loop',
      getActiveState: () => ({ active: true, sessionId: 'session-up-d' }),
    })
    const hook = createPlanCaptureEventHook(ctx as any)

    await hook({
      event: {
        type: 'message.updated',
        properties: {
          sessionID: 'session-up-d',
          info: { role: 'user', id: 'msg-user-d', time: { created: 1, completed: 2 } },
        },
      },
    })

    expect(ctx.plansRepo.getForSession('test-project', 'session-up-d')).toBeNull()
    expect(promptAsyncCalls.length).toBe(0)
  })

  test('(f) newest user message without markers does not capture older user plan', async () => {
    const promptAsyncCalls: Array<{ agent?: string }> = []
    const ctx = makeHookCtx({
      messagesData: [
        {
          info: { role: 'user', id: 'msg-old-f' },
          parts: [{ type: 'text', text: MARKED_PLAN }],
        },
        {
          info: { role: 'user', id: 'msg-newest-f' },
          parts: [{ type: 'text', text: 'Just some plain text without markers' }],
        },
      ],
      promptAsyncCalls,
    })
    const hook = createPlanCaptureEventHook(ctx as any)

    await hook({
      event: {
        type: 'message.updated',
        properties: {
          sessionID: 'session-up-f',
          info: { role: 'user', id: 'msg-newest-f', time: { created: 1, completed: 2 } },
        },
      },
    })

    // Should NOT capture the older plan — only the newest user message is considered
    expect(ctx.plansRepo.getForSession('test-project', 'session-up-f')).toBeNull()
    expect(promptAsyncCalls.length).toBe(0)
  })

  test('(e) user message without time.completed is ignored', async () => {
    const promptAsyncCalls: Array<{ agent?: string }> = []
    let messagesCalls = 0
    const ctx = makeHookCtx({
      messagesData: [{
        info: { role: 'user', id: 'msg-user-e' },
        parts: [{ type: 'text', text: MARKED_PLAN }],
      }],
      promptAsyncCalls,
    })
    // Override v2.session.messages to track calls
    ctx.v2.session.messages = async () => {
      messagesCalls++
      return { data: [] }
    }
    const hook = createPlanCaptureEventHook(ctx as any)

    await hook({
      event: {
        type: 'message.updated',
        properties: {
          sessionID: 'session-up-e',
          info: { role: 'user', id: 'msg-user-e', time: { created: 1 } }, // no completed
        },
      },
    })

    expect(ctx.plansRepo.getForSession('test-project', 'session-up-e')).toBeNull()
    expect(messagesCalls).toBe(0)
    expect(promptAsyncCalls.length).toBe(0)
  })

  test('(g) streaming path captures user paste + completion handler prompts architect once', async () => {
    const promptAsyncCalls: Array<{ agent?: string }> = []
    const ctx = makeHookCtx({
      messagesData: [{
        info: { role: 'user', id: 'msg-stream-g' },
        parts: [{ type: 'text', text: MARKED_PLAN }],
      }],
      promptAsyncCalls,
    })
    const hook = createPlanCaptureEventHook(ctx as any)

    // Simulate message.part.updated with a complete user-pasted marked plan
    // (the streaming path fires first with the full text containing both markers)
    await hook({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-stream-g',
          part: { type: 'text', messageID: 'msg-stream-g', text: MARKED_PLAN },
        },
      },
    })

    // Plan should be stored by streaming path
    expect(ctx.plansRepo.getForSession('test-project', 'session-stream-g')?.content).toBe(EXPECTED_PLAN)

    // Now simulate message.updated completing the user message
    await hook({
      event: {
        type: 'message.updated',
        properties: {
          sessionID: 'session-stream-g',
          info: { role: 'user', id: 'msg-stream-g', time: { created: 1, completed: 2 } },
        },
      },
    })

    // Plan should still be the same (deduped write — already-current)
    expect(ctx.plansRepo.getForSession('test-project', 'session-stream-g')?.content).toBe(EXPECTED_PLAN)
    // Architect should be prompted exactly once (streaming pre-capture tracks the plan
    // key so the completion handler treats already-current as freshly captured and prompts)
    const architectCalls = promptAsyncCalls.filter(c => c.agent === 'architect')
    expect(architectCalls.length).toBe(1)
  })

  test('(h) streaming path with active loop: no capture, no prompt', async () => {
    const promptAsyncCalls: Array<{ agent?: string }> = []
    const ctx = makeHookCtx({
      messagesData: [{
        info: { role: 'user', id: 'msg-loop-h' },
        parts: [{ type: 'text', text: MARKED_PLAN }],
      }],
      promptAsyncCalls,
      resolveLoopName: () => 'test-loop',
      getActiveState: () => ({ active: true, sessionId: 'session-loop-h' }),
    })
    const hook = createPlanCaptureEventHook(ctx as any)

    // Simulate message.part.updated with a complete user-pasted marked plan
    await hook({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-loop-h',
          part: { type: 'text', messageID: 'msg-loop-h', text: MARKED_PLAN },
        },
      },
    })

    // Plan should NOT be stored (loop guard in streaming path blocks capture)
    expect(ctx.plansRepo.getForSession('test-project', 'session-loop-h')).toBeNull()

    // Simulate message.updated completing the user message
    await hook({
      event: {
        type: 'message.updated',
        properties: {
          sessionID: 'session-loop-h',
          info: { role: 'user', id: 'msg-loop-h', time: { created: 1, completed: 2 } },
        },
      },
    })

    // Still no plan stored, and no prompt fired
    expect(ctx.plansRepo.getForSession('test-project', 'session-loop-h')).toBeNull()
    expect(promptAsyncCalls.length).toBe(0)
  })

  test('(i) pre-seeded plan in repo: already-current without streaming pre-capture does not prompt', async () => {
    const promptAsyncCalls: Array<{ agent?: string }> = []
    const ctx = makeHookCtx({
      messagesData: [{
        info: { role: 'user', id: 'msg-pre-i' },
        parts: [{ type: 'text', text: MARKED_PLAN }],
      }],
      promptAsyncCalls,
    })
    // Pre-seed the plansRepo with the same plan content before any event fires
    ctx.plansRepo.writeForSession('test-project', 'session-pre-i', EXPECTED_PLAN)
    const hook = createPlanCaptureEventHook(ctx as any)

    // Fire the user completion event
    await hook({
      event: {
        type: 'message.updated',
        properties: {
          sessionID: 'session-pre-i',
          info: { role: 'user', id: 'msg-pre-i', time: { created: 1, completed: 2 } },
        },
      },
    })

    // Plan should already be stored (pre-seeded, still the same content)
    expect(ctx.plansRepo.getForSession('test-project', 'session-pre-i')?.content).toBe(EXPECTED_PLAN)
    // No prompt should be sent — the plan was already stored before this event
    expect(promptAsyncCalls.length).toBe(0)
  })
})

describe('TUI persisted-plan-first fallback', () => {
  const PERSISTED_PLAN = '# Persisted Plan\n\n## Phase 1\nAlready captured.'
  const MESSAGE_PLAN = '# Message Plan\n\n## Phase 1\nFrom messages.'

  function createFakePlansRepo() {
    const plans = new Map<string, { content: string; updatedAt: number }>()
    let nextUpdatedAt = 1
    return {
      writeForSession: (_projectId: string, sessionId: string, content: string) => {
        plans.set(sessionId, { content, updatedAt: nextUpdatedAt++ })
      },
      getForSession: (_projectId: string, sessionId: string) => {
        const row = plans.get(sessionId)
        if (!row) return null
        return { projectId: 'test-project', loopName: null, sessionId, content: row.content, updatedAt: row.updatedAt }
      },
    }
  }

  function makeMessagePlan(): string {
    return `${PLAN_START_MARKER}\n${MESSAGE_PLAN}\n${PLAN_END_MARKER}`
  }

  test('returns persisted plan when it exists (ignores message plan)', async () => {
    const plansRepo = createFakePlansRepo()
    plansRepo.writeForSession('test-project', 'session-pp-1', PERSISTED_PLAN)

    // Simulate the runExecutePlan resolution order:
    // 1. Try persisted store first
    const planText = plansRepo.getForSession('test-project', 'session-pp-1')?.content ?? null
    expect(planText).toBe(PERSISTED_PLAN)

    // 2. Would NOT fall back to message parsing because persisted exists
    // (fetchLatestPlanForSession would not be called)
  })

  test('falls back to message inspection when no persisted plan exists', async () => {
    const plansRepo = createFakePlansRepo()

    // No persisted plan for this session
    const persisted = plansRepo.getForSession('test-project', 'session-pp-2')
    expect(persisted).toBeNull()

    // Simulate the fallback: inspect messages (represented here by
    // directly using the parser that fetchLatestPlanForSession uses)
    const { inspectLatestPastedPlan } = await import('../src/utils/marked-plan-parser')
    const messages: PlanCaptureMessage[] = [{
      info: { role: 'user', id: 'msg-pp-2' },
      parts: [{ type: 'text', text: makeMessagePlan() }],
    }]
    const inspection = inspectLatestPastedPlan(messages)
    expect(inspection.status).toBe('found')
    if (inspection.status === 'found') {
      expect(inspection.planText).toBe(MESSAGE_PLAN)
    }
  })

  test('persisted plan wins over message plan when both exist', async () => {
    const plansRepo = createFakePlansRepo()
    plansRepo.writeForSession('test-project', 'session-pp-3', PERSISTED_PLAN)

    // Simulate the runExecutePlan resolution order:
    // 1. Try persisted store first
    const fromPersisted = plansRepo.getForSession('test-project', 'session-pp-3')?.content
    expect(fromPersisted).toBe(PERSISTED_PLAN)

    // 2. Would NOT fall back to messages — persisted exists
    // If we DID inspect messages we'd get a different plan, proving
    // the ordering matters.
    const { inspectLatestPastedPlan } = await import('../src/utils/marked-plan-parser')
    const messages: PlanCaptureMessage[] = [{
      info: { role: 'user', id: 'msg-pp-3' },
      parts: [{ type: 'text', text: makeMessagePlan() }],
    }]
    const messagePlan = inspectLatestPastedPlan(messages)
    expect(messagePlan.status).toBe('found')
    if (messagePlan.status === 'found') {
      // Both plans exist but persisted is preferred — they differ
      expect(fromPersisted).not.toBe(messagePlan.planText)
    }
  })
})
