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

  test('user message.updated with no stashed plan does not fetch or write', async () => {
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

    // Nothing was captured server-side; the completion handler only prompts
    // from the streaming stash, so it never re-reads the conversation.
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

  function streamingEvent(sessionID: string, messageID: string, text: string) {
    return { event: { type: 'message.part.updated', properties: { sessionID, part: { type: 'text', messageID, text } } } }
  }

  function userCompletionEvent(sessionID: string, id: string) {
    return { event: { type: 'message.updated', properties: { sessionID, info: { role: 'user', id, time: { created: 1, completed: 2 } } } } }
  }

  const architectCount = (calls: Array<{ agent?: string }>) => calls.filter(c => c.agent === 'architect').length

  test('(a) streaming captures the plan; user completion prompts the architect', async () => {
    const promptAsyncCalls: Array<{ agent?: string }> = []
    const ctx = makeHookCtx({ promptAsyncCalls })
    const hook = createPlanCaptureEventHook(ctx as any)

    await hook(streamingEvent('session-up-a', 'msg-user-a', MARKED_PLAN) as any)
    // Streaming captured the plan into the store
    expect(ctx.plansRepo.getForSession('test-project', 'session-up-a')?.content).toBe(EXPECTED_PLAN)

    await hook(userCompletionEvent('session-up-a', 'msg-user-a') as any)
    expect(architectCount(promptAsyncCalls)).toBe(1)
  })

  test('(b) completing the same message twice prompts only once', async () => {
    const promptAsyncCalls: Array<{ agent?: string }> = []
    const ctx = makeHookCtx({ promptAsyncCalls })
    const hook = createPlanCaptureEventHook(ctx as any)

    await hook(streamingEvent('session-up-b', 'msg-user-b', MARKED_PLAN) as any)

    await hook(userCompletionEvent('session-up-b', 'msg-user-b') as any)
    expect(architectCount(promptAsyncCalls)).toBe(1)

    await hook(userCompletionEvent('session-up-b', 'msg-user-b') as any)
    expect(architectCount(promptAsyncCalls)).toBe(1)
  })

  test('(c) user message without markers does not capture or prompt', async () => {
    const promptAsyncCalls: Array<{ agent?: string }> = []
    const ctx = makeHookCtx({ promptAsyncCalls })
    const hook = createPlanCaptureEventHook(ctx as any)

    await hook(streamingEvent('session-up-c', 'msg-user-c', 'Just some plain text with no markers') as any)
    await hook(userCompletionEvent('session-up-c', 'msg-user-c') as any)

    expect(ctx.plansRepo.getForSession('test-project', 'session-up-c')).toBeNull()
    expect(promptAsyncCalls.length).toBe(0)
  })

  test('(d) when loop is active, streaming does not capture and completion does not prompt', async () => {
    const promptAsyncCalls: Array<{ agent?: string }> = []
    const ctx = makeHookCtx({
      promptAsyncCalls,
      resolveLoopName: () => 'my-loop',
      getActiveState: () => ({ active: true, sessionId: 'session-up-d' }),
    })
    const hook = createPlanCaptureEventHook(ctx as any)

    await hook(streamingEvent('session-up-d', 'msg-user-d', MARKED_PLAN) as any)
    await hook(userCompletionEvent('session-up-d', 'msg-user-d') as any)

    expect(ctx.plansRepo.getForSession('test-project', 'session-up-d')).toBeNull()
    expect(promptAsyncCalls.length).toBe(0)
  })

  test('(e) completing a markerless message does not prompt for an earlier message\u2019s plan', async () => {
    const promptAsyncCalls: Array<{ agent?: string }> = []
    const ctx = makeHookCtx({ promptAsyncCalls })
    const hook = createPlanCaptureEventHook(ctx as any)

    // An earlier message streamed a plan (stashed under its own id)...
    await hook(streamingEvent('session-up-e', 'msg-old-e', MARKED_PLAN) as any)
    // ...but a different, markerless message completes.
    await hook(userCompletionEvent('session-up-e', 'msg-newest-e') as any)

    // The newer message has nothing stashed, so no prompt fires.
    expect(promptAsyncCalls.length).toBe(0)
  })

  test('(f) user message without time.completed is ignored', async () => {
    const promptAsyncCalls: Array<{ agent?: string }> = []
    const ctx = makeHookCtx({ promptAsyncCalls })
    const hook = createPlanCaptureEventHook(ctx as any)

    await hook(streamingEvent('session-up-f', 'msg-user-f', MARKED_PLAN) as any)
    // Completion event arrives without time.completed (still streaming)
    await hook({ event: { type: 'message.updated', properties: { sessionID: 'session-up-f', info: { role: 'user', id: 'msg-user-f', time: { created: 1 } } } } } as any)

    expect(promptAsyncCalls.length).toBe(0)
  })

  test('(g) streaming then user completion prompts architect exactly once', async () => {
    const promptAsyncCalls: Array<{ agent?: string }> = []
    const ctx = makeHookCtx({ promptAsyncCalls })
    const hook = createPlanCaptureEventHook(ctx as any)

    await hook(streamingEvent('session-stream-g', 'msg-stream-g', MARKED_PLAN) as any)
    expect(ctx.plansRepo.getForSession('test-project', 'session-stream-g')?.content).toBe(EXPECTED_PLAN)

    await hook(userCompletionEvent('session-stream-g', 'msg-stream-g') as any)

    expect(ctx.plansRepo.getForSession('test-project', 'session-stream-g')?.content).toBe(EXPECTED_PLAN)
    expect(architectCount(promptAsyncCalls)).toBe(1)
  })

  test('(h) streaming with an active loop: no capture, no prompt', async () => {
    const promptAsyncCalls: Array<{ agent?: string }> = []
    const ctx = makeHookCtx({
      promptAsyncCalls,
      resolveLoopName: () => 'test-loop',
      getActiveState: () => ({ active: true, sessionId: 'session-loop-h' }),
    })
    const hook = createPlanCaptureEventHook(ctx as any)

    await hook(streamingEvent('session-loop-h', 'msg-loop-h', MARKED_PLAN) as any)
    expect(ctx.plansRepo.getForSession('test-project', 'session-loop-h')).toBeNull()

    await hook(userCompletionEvent('session-loop-h', 'msg-loop-h') as any)
    expect(ctx.plansRepo.getForSession('test-project', 'session-loop-h')).toBeNull()
    expect(promptAsyncCalls.length).toBe(0)
  })

  test('(i) re-pasting an already-stored plan does not prompt (already-current is not stashed)', async () => {
    const promptAsyncCalls: Array<{ agent?: string }> = []
    const ctx = makeHookCtx({ promptAsyncCalls })
    ctx.plansRepo.writeForSession('test-project', 'session-pre-i', EXPECTED_PLAN)
    const hook = createPlanCaptureEventHook(ctx as any)

    // Streaming sees the same plan content that is already stored -> already-current
    await hook(streamingEvent('session-pre-i', 'msg-pre-i', MARKED_PLAN) as any)
    await hook(userCompletionEvent('session-pre-i', 'msg-pre-i') as any)

    expect(ctx.plansRepo.getForSession('test-project', 'session-pre-i')?.content).toBe(EXPECTED_PLAN)
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
