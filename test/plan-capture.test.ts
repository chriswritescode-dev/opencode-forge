import { describe, test, expect } from 'bun:test'
import {
  extractMarkedPlan,
  normalizePastedPlanText,
  messageText,
  inspectLatestMarkedPlan,
  PLAN_START_MARKER,
  PLAN_END_MARKER,
  type PlanCaptureMessage,
} from '../src/utils/marked-plan-parser'
import { captureMarkedPlanTextForSession, captureLatestPlanForSession } from '../src/services/plan-capture'
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

  test('ignores message.updated when role is user', async () => {
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

    expect(plansRepo.getForSession('test-project', 'session-mu-user')).toBeNull()
    expect(messagesCalls).toBe(0)
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
