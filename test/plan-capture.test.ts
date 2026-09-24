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

describe('plan capture event hook without a directory scope', () => {
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

  const locatedText = `${PLAN_START_MARKER}
# Objective

Change /project-a/src/index.ts
${PLAN_END_MARKER}`

  test('events without a directory scope keep capturing through the receiver', async () => {
    const plansRepo = createFakePlansRepo()
    const hook = createPlanCaptureEventHook({
      client: { session: { messages: async () => [] } },
      plansRepo,
      projectId: 'project-a',
      directory: '/project-a',
      logger,
    } as any)

    await hook({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-a',
          part: { type: 'text', messageID: 'message-a', text: locatedText },
        },
      },
    })

    expect(plansRepo.getForSession('project-a', 'session-a')?.content).toBe('# Objective\n\nChange src/index.ts')
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
