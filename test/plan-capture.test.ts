import { describe, test, expect } from 'vitest'
import {
  extractMarkedPlan,
  normalizePastedPlanText,
  messageText,
  inspectLatestMarkedPlan,
  PLAN_START_MARKER,
  PLAN_END_MARKER,
  type PlanCaptureMessage,
} from '../src/utils/marked-plan-parser'
import { captureMarkedPlanTextForSession, captureLatestPlanForSession, capturePlanForCompletedMessage } from '../src/services/plan-capture'
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

  test('markers inside a fenced code block are treated as missing', () => {
    const text = [
      'Preamble',
      '```',
      PLAN_START_MARKER,
      '# Fake Plan',
      PLAN_END_MARKER,
      '```',
      'Outro',
    ].join('\n')

    const result = extractMarkedPlan(text)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('missing')
    }
  })

  test('plan body containing balanced fenced code blocks is captured verbatim', () => {
    const text = [
      PLAN_START_MARKER,
      '# Real Plan',
      '',
      '```ts',
      'const a = 1',
      '```',
      '',
      '```',
      'const b = 2',
      '```',
      '',
      '## Verification',
      '- pnpm typecheck',
      PLAN_END_MARKER,
    ].join('\n')

    const result = extractMarkedPlan(text)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.planText).toContain('```ts\nconst a = 1\n```')
      expect(result.planText).toContain('```\nconst b = 2\n```')
      expect(result.planText).not.toContain(PLAN_START_MARKER)
      expect(result.planText).not.toContain(PLAN_END_MARKER)
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

  test('fenced-only marker example does not overwrite a previously stored plan', () => {
    const plansRepo = createFakePlansRepo()
    const realText = `${PLAN_START_MARKER}
# Real Plan
${PLAN_END_MARKER}`
    captureMarkedPlanTextForSession(
      { plansRepo: plansRepo as any, projectId: 'test-project', logger },
      'session-1',
      realText,
      'message-1'
    )

    const before = plansRepo.getForSession('test-project', 'session-1')?.content

    const fencedExample = [
      'Here is an example of plan markers:',
      '```',
      PLAN_START_MARKER,
      '# Example Plan',
      PLAN_END_MARKER,
      '```',
    ].join('\n')

    const result = captureMarkedPlanTextForSession(
      { plansRepo: plansRepo as any, projectId: 'test-project', logger },
      'session-1',
      fencedExample,
      'message-2'
    )

    expect(result.status).toBe('not-found')
    expect(plansRepo.getForSession('test-project', 'session-1')?.content).toBe(before)
    expect(plansRepo.getForSession('test-project', 'session-1')?.content).toBe('# Real Plan')
  })

  test('message part event auto-captures before idle or approval', async () => {
    const plansRepo = createFakePlansRepo()
    const hook = createPlanCaptureEventHook({
      client: { session: { messages: async () => [] } },
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

describe('captureLatestPlanForSession with ForgeClient', () => {
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
    parts: [{ type: 'text', text: `${PLAN_START_MARKER}\nFound Plan\n${PLAN_END_MARKER}` }],
  }

  test('returns plan when client returns messages', async () => {
    const plansRepo = createFakePlansRepo()
    const deps = {
      client: { session: { messages: async () => [planMessage] } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    }

    const result = await captureLatestPlanForSession(deps as any, 'session-found')

    expect(result.status).toBe('captured')
    expect(plansRepo.getForSession('test-project', 'session-found')?.content).toBe('Found Plan')
  })

  test('returns not-found when client returns empty messages', async () => {
    const plansRepo = createFakePlansRepo()
    const deps = {
      client: { session: { messages: async () => [] } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    }

    const result = await captureLatestPlanForSession(deps as any, 'session-empty')

    expect(result.status).toBe('not-found')
    expect(plansRepo.getForSession('test-project', 'session-empty')).toBeNull()
  })

  test('returns read-failed when client throws', async () => {
    const plansRepo = createFakePlansRepo()
    const deps = {
      client: { session: { messages: async () => { throw new Error('network error') } } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    }

    const result = await captureLatestPlanForSession(deps as any, 'session-error')

    expect(result.status).toBe('read-failed')
    expect(plansRepo.getForSession('test-project', 'session-error')).toBeNull()
  })

  test('preserves a plan-write row that lands while message retrieval is pending', async () => {
    // Race regression: `execute-plan` checks storage (empty), awaits
    // `session.messages`, and during that await a concurrent `plan-write`
    // stores a newer revision. Legacy capture must not overwrite it with the
    // older marked plan from history.
    const plansRepo = createFakePlansRepo()

    let resolveMessages!: (messages: PlanCaptureMessage[]) => void
    const messagesPromise = new Promise<PlanCaptureMessage[]>((resolve) => {
      resolveMessages = resolve
    })

    const deps = {
      client: { session: { messages: async () => messagesPromise } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    }

    const capturePromise = captureLatestPlanForSession(deps as any, 'session-race')

    // While message retrieval is pending, plan-write stores a newer row.
    plansRepo.writeForSession('test-project', 'session-race', '# plan-write revision')
    const before = plansRepo.getForSession('test-project', 'session-race')

    // Now message retrieval resolves with an older marked plan in history.
    resolveMessages([planMessage])

    const result = await capturePromise

    expect(result.status).toBe('already-current')
    const after = plansRepo.getForSession('test-project', 'session-race')
    expect(after?.content).toBe('# plan-write revision')
    expect(after?.updatedAt).toBe(before?.updatedAt)
  })

  test('still captures from history when no row appears during message retrieval', async () => {
    const plansRepo = createFakePlansRepo()
    const deps = {
      client: { session: { messages: async () => [planMessage] } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    }

    const result = await captureLatestPlanForSession(deps as any, 'session-no-row')

    expect(result.status).toBe('captured')
    expect(plansRepo.getForSession('test-project', 'session-no-row')?.content).toBe('Found Plan')
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
      client: { session: { messages: async () => messages } },
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
      client: { session: { messages: async () => {
        messagesCalls++
        return []
      } } },
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
      client: { session: { messages: async () => {
        messagesCalls++
        return []
      } } },
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
      client: { session: { messages: async () => messages } },
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

describe('capturePlanForCompletedMessage (stored-plan precedence)', () => {
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

  const olderMarkedPlan = {
    info: { role: 'assistant', id: 'msg-old' },
    parts: [{ type: 'text', text: `${PLAN_START_MARKER}\n# Old Plan\n${PLAN_END_MARKER}` }],
  }

  const markerFreeCompletion = {
    info: { role: 'assistant', id: 'msg-current', time: { created: 3, completed: 4 } },
    parts: [{ type: 'text', text: 'Here is a status update, no plan this time.' }],
  }

  test('writes when the completing message contains a marked plan', async () => {
    const plansRepo = createFakePlansRepo()
    const messages = [
      olderMarkedPlan,
      {
        info: { role: 'assistant', id: 'msg-current', time: { created: 3, completed: 4 } },
        parts: [{ type: 'text', text: `${PLAN_START_MARKER}\n# New Plan\n${PLAN_END_MARKER}` }],
      },
    ]
    const deps = {
      client: { session: { messages: async () => messages } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    }

    const result = await capturePlanForCompletedMessage(deps as any, 'session-prec', 'msg-current')

    expect(result.status).toBe('captured')
    expect(plansRepo.getForSession('test-project', 'session-prec')?.content).toBe('# New Plan')
  })

  test('does not overwrite a newer stored row when a marker-free completion has an older marked message in history', async () => {
    const plansRepo = createFakePlansRepo()
    plansRepo.writeForSession('test-project', 'session-prec', '# plan-write revision')
    const before = plansRepo.getForSession('test-project', 'session-prec')

    const deps = {
      client: { session: { messages: async () => [olderMarkedPlan, markerFreeCompletion] } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    }

    const result = await capturePlanForCompletedMessage(deps as any, 'session-prec', 'msg-current')

    expect(result.status).toBe('not-found')
    expect(plansRepo.getForSession('test-project', 'session-prec')?.content).toBe('# plan-write revision')
    expect(plansRepo.getForSession('test-project', 'session-prec')?.updatedAt).toBe(before?.updatedAt)
  })

  test('writes when the completing message is the split-message end marker', async () => {
    const plansRepo = createFakePlansRepo()
    const messages = [
      {
        info: { role: 'assistant', id: 'msg-start' },
        parts: [{ type: 'text', text: `${PLAN_START_MARKER}\n## Phase 1: Build` }],
      },
      {
        info: { role: 'assistant', id: 'msg-end', time: { created: 3, completed: 4 } },
        parts: [{ type: 'text', text: PLAN_END_MARKER }],
      },
    ]
    const deps = {
      client: { session: { messages: async () => messages } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    }

    const result = await capturePlanForCompletedMessage(deps as any, 'session-split', 'msg-end')

    expect(result.status).toBe('captured')
    expect(plansRepo.getForSession('test-project', 'session-split')?.content).toContain('## Phase 1: Build')
  })

  test('does not replay an earlier split-message start from a different completion', async () => {
    const plansRepo = createFakePlansRepo()
    plansRepo.writeForSession('test-project', 'session-prec', '# plan-write revision')
    const before = plansRepo.getForSession('test-project', 'session-prec')

    // An orphaned start marker in history (no later end) plus a marker-free
    // completion must not touch the row.
    const messages: PlanCaptureMessage[] = [
      {
        info: { role: 'assistant', id: 'msg-start' },
        parts: [{ type: 'text', text: `${PLAN_START_MARKER}\n## Phase 1: Build` }],
      },
      markerFreeCompletion,
    ]
    const deps = {
      client: { session: { messages: async () => messages } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    }

    const result = await capturePlanForCompletedMessage(deps as any, 'session-prec', 'msg-current')

    expect(result.status).toBe('not-found')
    expect(plansRepo.getForSession('test-project', 'session-prec')?.content).toBe('# plan-write revision')
    expect(plansRepo.getForSession('test-project', 'session-prec')?.updatedAt).toBe(before?.updatedAt)
  })

  test('preserves a same-timestamp different-content row that lands while message retrieval is pending', async () => {
    // Regression: writes use millisecond-resolution `Date.now()`, so a
    // concurrent `plan-edit` can store different content with the same
    // `updatedAt` as the snapshot. A timestamp-only check would miss that and
    // let the stale marked plan overwrite the revision. The revalidation must
    // compare content.
    const plans: Map<string, { content: string; updatedAt: number }> = new Map()
    const fixedTimestamp = 1_700_000_000_000
    const plansRepo = {
      writeForSession: (_projectId: string, sessionId: string, content: string) => {
        plans.set(sessionId, { content, updatedAt: fixedTimestamp })
      },
      getForSession: (_projectId: string, sessionId: string) => {
        const row = plans.get(sessionId)
        if (!row) return null
        return { projectId: 'test-project', loopName: null, sessionId, content: row.content, updatedAt: row.updatedAt }
      },
    }

    // Seed the row that the completion path will snapshot.
    plansRepo.writeForSession('test-project', 'session-same-ts', '# original')
    const snapshot = plansRepo.getForSession('test-project', 'session-same-ts')
    expect(snapshot?.updatedAt).toBe(fixedTimestamp)

    let resolveMessages!: (messages: PlanCaptureMessage[]) => void
    const messagesPromise = new Promise<PlanCaptureMessage[]>((resolve) => {
      resolveMessages = resolve
    })

    const completingMessage: PlanCaptureMessage = {
      info: { role: 'assistant', id: 'msg-current' },
      parts: [{ type: 'text', text: `${PLAN_START_MARKER}\n# Stale Marked Plan\n${PLAN_END_MARKER}` }],
    }

    const deps = {
      client: { session: { messages: async () => messagesPromise } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    }

    const capturePromise = capturePlanForCompletedMessage(deps as any, 'session-same-ts', 'msg-current')

    // While message retrieval is pending, plan-edit stores different content
    // with the SAME `updatedAt` as the snapshot.
    plansRepo.writeForSession('test-project', 'session-same-ts', '# plan-edit revision')
    const concurrent = plansRepo.getForSession('test-project', 'session-same-ts')
    expect(concurrent?.content).toBe('# plan-edit revision')
    expect(concurrent?.updatedAt).toBe(snapshot?.updatedAt)

    resolveMessages([completingMessage])

    const result = await capturePromise

    expect(result.status).toBe('already-current')
    const after = plansRepo.getForSession('test-project', 'session-same-ts')
    expect(after?.content).toBe('# plan-edit revision')
    expect(after?.updatedAt).toBe(fixedTimestamp)
  })

  test('preserves a same-content newer-timestamp row that lands while message retrieval is pending (A→B→A)', async () => {
    // Regression: a concurrent revision can restore the snapshot's content at
    // a newer `updatedAt` (e.g. plan-edit A→B→A). A content-only revalidation
    // would see matching content and let the stale marked message overwrite
    // the newer revision. The revalidation must also compare `updatedAt`.
    const plans: Map<string, { content: string; updatedAt: number }> = new Map()
    const plansRepo = {
      writeForSession: (_projectId: string, sessionId: string, content: string, updatedAt?: number) => {
        plans.set(sessionId, { content, updatedAt: updatedAt ?? Date.now() })
      },
      getForSession: (_projectId: string, sessionId: string) => {
        const row = plans.get(sessionId)
        if (!row) return null
        return { projectId: 'test-project', loopName: null, sessionId, content: row.content, updatedAt: row.updatedAt }
      },
    }

    // Seed plan A; this is what the completion path will snapshot.
    plansRepo.writeForSession('test-project', 'session-aba', '# plan A', 1_700_000_000_000)
    const snapshot = plansRepo.getForSession('test-project', 'session-aba')
    expect(snapshot?.content).toBe('# plan A')

    let resolveMessages!: (messages: PlanCaptureMessage[]) => void
    const messagesPromise = new Promise<PlanCaptureMessage[]>((resolve) => {
      resolveMessages = resolve
    })

    const completingMessage: PlanCaptureMessage = {
      info: { role: 'assistant', id: 'msg-current' },
      parts: [{ type: 'text', text: `${PLAN_START_MARKER}\n# Stale Marked Plan\n${PLAN_END_MARKER}` }],
    }

    const deps = {
      client: { session: { messages: async () => messagesPromise } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    }

    const capturePromise = capturePlanForCompletedMessage(deps as any, 'session-aba', 'msg-current')

    // While message retrieval is pending, a concurrent edit does A→B→A with a
    // newer `updatedAt` but the same content as the snapshot.
    plansRepo.writeForSession('test-project', 'session-aba', '# plan B', 1_700_000_000_001)
    plansRepo.writeForSession('test-project', 'session-aba', '# plan A', 1_700_000_000_002)
    const concurrent = plansRepo.getForSession('test-project', 'session-aba')
    expect(concurrent?.content).toBe('# plan A')
    expect(concurrent?.updatedAt).toBeGreaterThan(snapshot!.updatedAt)

    resolveMessages([completingMessage])

    const result = await capturePromise

    expect(result.status).toBe('already-current')
    const after = plansRepo.getForSession('test-project', 'session-aba')
    expect(after?.content).toBe('# plan A')
    expect(after?.updatedAt).toBe(1_700_000_000_002)
  })

  test('preserves a newer stored row that lands while message retrieval is pending even when the completing message has a marked plan', async () => {
    // Race regression: completion capture snapshots an empty row, awaits
    // `session.messages`, and during that await a concurrent `plan-write`
    // stores a newer revision. The completing message itself carries a marked
    // plan, but it is older than the tool-authored row and must not overwrite.
    const plansRepo = createFakePlansRepo()

    let resolveMessages!: (messages: PlanCaptureMessage[]) => void
    const messagesPromise = new Promise<PlanCaptureMessage[]>((resolve) => {
      resolveMessages = resolve
    })

    const completingMessage: PlanCaptureMessage = {
      info: { role: 'assistant', id: 'msg-current' },
      parts: [{ type: 'text', text: `${PLAN_START_MARKER}\n# Marked Plan\n${PLAN_END_MARKER}` }],
    }

    const deps = {
      client: { session: { messages: async () => messagesPromise } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    }

    const capturePromise = capturePlanForCompletedMessage(deps as any, 'session-race', 'msg-current')

    // While message retrieval is pending, plan-write stores a newer row.
    plansRepo.writeForSession('test-project', 'session-race', '# plan-write revision')
    const before = plansRepo.getForSession('test-project', 'session-race')

    resolveMessages([completingMessage])

    const result = await capturePromise

    expect(result.status).toBe('already-current')
    const after = plansRepo.getForSession('test-project', 'session-race')
    expect(after?.content).toBe('# plan-write revision')
    expect(after?.updatedAt).toBe(before?.updatedAt)
  })
})

describe('plan-capture hook stored-plan precedence', () => {
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

  test('an older marked plan in history does not overwrite a newer plan-write row on a marker-free completion', async () => {
    const plansRepo = createFakePlansRepo()
    const messages = [
      {
        info: { role: 'assistant', id: 'msg-architect', time: { created: 1, completed: 2 } },
        parts: [{ type: 'text', text: `${PLAN_START_MARKER}\n# Stale Architect Plan\n${PLAN_END_MARKER}` }],
      },
      {
        info: { role: 'assistant', id: 'msg-free', time: { created: 3, completed: 4 } },
        parts: [{ type: 'text', text: 'Acknowledged — proceeding with the revised plan.' }],
      },
    ]
    const hook = createPlanCaptureEventHook({
      client: { session: { messages: async () => messages } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    } as any)

    // plan-write authored a newer revision
    plansRepo.writeForSession('test-project', 'session-prec', '# plan-write revision')
    const beforeHook = plansRepo.getForSession('test-project', 'session-prec')

    // Marker-free completion fires the hook
    await hook({ event: { type: 'message.updated', properties: { sessionID: 'session-prec', info: messages[1].info } } })

    const after = plansRepo.getForSession('test-project', 'session-prec')
    expect(after?.content).toBe('# plan-write revision')
    expect(after?.updatedAt).toBe(beforeHook?.updatedAt)
  })

  test('a newly completed marked plan still captures through the completion hook', async () => {
    const plansRepo = createFakePlansRepo()
    const messages = [{
      info: { role: 'assistant', id: 'msg-marked', time: { created: 1, completed: 2 } },
      parts: [{ type: 'text', text: `${PLAN_START_MARKER}\n# Fresh Plan\n${PLAN_END_MARKER}` }],
    }]
    const hook = createPlanCaptureEventHook({
      client: { session: { messages: async () => messages } },
      plansRepo,
      projectId: 'test-project',
      directory: '/tmp/project',
      logger,
    } as any)

    await hook({ event: { type: 'message.updated', properties: { sessionID: 'session-fresh', info: messages[0].info } } })

    expect(plansRepo.getForSession('test-project', 'session-fresh')?.content).toBe('# Fresh Plan')
  })
})
