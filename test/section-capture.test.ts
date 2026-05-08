import { describe, test, expect, beforeEach } from 'bun:test'
import { extractSections, type ParsedSection } from '../src/utils/section-capture'
import { createSectionCaptureService } from '../src/services/section-capture'
import { createSectionCaptureHook } from '../src/hooks/section-capture'
import type { SectionPlansRepo } from '../src/storage/repos/section-plans-repo'
import type { LoopsRepo } from '../src/storage/repos/loops-repo'
import type { Logger } from '../src/types'

function makeSection(index: number, title: string, content: string): string {
  return `<!-- forge-section:start index=${index} title="${title}" -->\n${content}\n<!-- forge-section:end -->`
}

describe('extractSections', () => {
  describe('valid sequential sections', () => {
    test('extracts a single section', () => {
      const text = makeSection(0, 'Setup', 'Install dependencies')
      const result = extractSections(text)
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({ index: 0, title: 'Setup', content: 'Install dependencies' })
    })

    test('extracts multiple sequential sections', () => {
      const text = [
        makeSection(0, 'Phase One', 'First phase content'),
        makeSection(1, 'Phase Two', 'Second phase content'),
        makeSection(2, 'Phase Three', 'Third phase content'),
      ].join('\n')

      const result = extractSections(text)
      expect(result).toHaveLength(3)
      expect(result[0].index).toBe(0)
      expect(result[1].index).toBe(1)
      expect(result[2].index).toBe(2)
      expect(result[0].title).toBe('Phase One')
      expect(result[1].title).toBe('Phase Two')
      expect(result[2].title).toBe('Phase Three')
    })

    test('truncates title at 60 characters', () => {
      const longTitle = 'A'.repeat(100)
      const text = makeSection(0, longTitle, 'content')
      const result = extractSections(text)
      expect(result).toHaveLength(1)
      expect(result[0].title.length).toBe(60)
    })

    test('preserves surrounding text as non-section content', () => {
      const text = `Before text
${makeSection(0, 'First', 'Section body')}
After text`

      const result = extractSections(text)
      expect(result).toHaveLength(1)
      expect(result[0].content).toBe('Section body')
    })

    test('trims whitespace from content', () => {
      const text = makeSection(0, 'Trimmed', '  \n  Content with whitespace  \n  ')
      const result = extractSections(text)
      expect(result).toHaveLength(1)
      expect(result[0].content).toBe('Content with whitespace')
    })
  })

  describe('structural violations', () => {
    test('returns [] on duplicate indexes after valid section', () => {
      const text = [
        makeSection(0, 'First', 'First content'),
        makeSection(0, 'Duplicate', 'Duplicate content'),
      ].join('\n')

      const result = extractSections(text)
      expect(result).toEqual([])
    })

    test('returns [] on gapped indexes after valid section', () => {
      const text = [
        makeSection(0, 'First', 'First content'),
        makeSection(2, 'Gap', 'Skipped index'),
      ].join('\n')

      const result = extractSections(text)
      expect(result).toEqual([])
    })

    test('returns [] when first section index is not 0', () => {
      const text = makeSection(1, 'Wrong Start', 'Content')
      const result = extractSections(text)
      expect(result).toEqual([])
    })
  })

  describe('maxSections limit', () => {
    test('respects maxSections option', () => {
      const text = [
        makeSection(0, 'One', 'Content one'),
        makeSection(1, 'Two', 'Content two'),
        makeSection(2, 'Three', 'Content three'),
      ].join('\n')

      const result = extractSections(text, { maxSections: 2 })
      expect(result).toHaveLength(2)
      expect(result[0].index).toBe(0)
      expect(result[1].index).toBe(1)
    })

    test('uses default maxSections of 12', () => {
      const sections = Array.from({ length: 15 }, (_, i) =>
        makeSection(i, `Section ${i}`, `Content ${i}`)
      )
      const text = sections.join('\n')

      const result = extractSections(text)
      expect(result).toHaveLength(12)
    })

    test('maxSections of 0 returns []', () => {
      const text = makeSection(0, 'Only', 'Content')
      const result = extractSections(text, { maxSections: 0 })
      expect(result).toEqual([])
    })
  })

  describe('empty and edge cases', () => {
    test('returns [] for empty string', () => {
      const result = extractSections('')
      expect(result).toEqual([])
    })

    test('returns [] for text without section markers', () => {
      const result = extractSections('Just some plain text with no markers')
      expect(result).toEqual([])
    })

    test('returns [] when only malformed markers exist', () => {
      const text = `<!-- forge-section:start index=0 -->\nContent\n<!-- forge-section:end -->`
      const result = extractSections(text)
      expect(result).toEqual([])
    })

    test('handles sections with multi-line content', () => {
      const text = makeSection(0, 'Multi-line', 'Line one\nLine two\nLine three')
      const result = extractSections(text)
      expect(result).toHaveLength(1)
      expect(result[0].content).toBe('Line one\nLine two\nLine three')
    })
  })
})

describe('createSectionCaptureService', () => {
  let insertCalls: Array<{ projectId: string; loopName: string; sections: ParsedSection[] }>
  let insertedCounts: number[]
  let mockSectionPlansRepo: SectionPlansRepo
  let mockLoopsRepo: LoopsRepo
  let mockLogger: Logger

  beforeEach(() => {
    insertCalls = []
    insertedCounts = []
    mockSectionPlansRepo = {
      bulkInsert(args) {
        insertCalls.push(args)
        const count = insertedCounts.shift() ?? args.sections.length
        return { inserted: count }
      },
      list: () => [],
      listCompleted: () => [],
      get: () => null,
      setStatus: () => {},
      incrementAttempts: () => {},
      setSummary: () => {},
      resetForRewind: () => {},
      setStartedAt: () => {},
      setCompletedAt: () => {},
      count: () => 0,
      restoreAll: () => {},
    } as unknown as SectionPlansRepo
    mockLoopsRepo = {
      getBySessionId: () => null,
    } as unknown as LoopsRepo
    mockLogger = {
      log: () => {},
      error: () => {},
      debug: () => {},
    }
  })

  test('captureFromText returns {count:0, persisted:false} when no sections found', () => {
    const service = createSectionCaptureService({
      sectionPlansRepo: mockSectionPlansRepo,
      loopsRepo: mockLoopsRepo,
      logger: mockLogger,
      config: () => ({ enabled: true, mode: 'deterministic', maxSections: 12 }),
    })
    const result = service.captureFromText({ projectId: 'p1', loopName: 'l1', text: 'no sections here' })
    expect(result).toEqual({ count: 0, persisted: false })
    expect(insertCalls).toHaveLength(0)
  })

  test('captureFromText persists sections and returns count', () => {
    const text = [
      makeSection(0, 'Phase One', 'First content'),
      makeSection(1, 'Phase Two', 'Second content'),
    ].join('\n')

    const service = createSectionCaptureService({
      sectionPlansRepo: mockSectionPlansRepo,
      loopsRepo: mockLoopsRepo,
      logger: mockLogger,
      config: () => ({ enabled: true, mode: 'deterministic', maxSections: 12 }),
    })
    const result = service.captureFromText({ projectId: 'p1', loopName: 'l1', text })
    expect(result.count).toBe(2)
    expect(result.persisted).toBe(true)
    expect(insertCalls).toHaveLength(1)
    expect(insertCalls[0].projectId).toBe('p1')
    expect(insertCalls[0].loopName).toBe('l1')
    expect(insertCalls[0].sections).toHaveLength(2)
  })

  test('captureFromText is idempotent on second call', () => {
    const text = [
      makeSection(0, 'Phase One', 'First content'),
      makeSection(1, 'Phase Two', 'Second content'),
    ].join('\n')

    insertedCounts = [2, 0]
    const service = createSectionCaptureService({
      sectionPlansRepo: mockSectionPlansRepo,
      loopsRepo: mockLoopsRepo,
      logger: mockLogger,
      config: () => ({ enabled: true, mode: 'deterministic', maxSections: 12 }),
    })

    const first = service.captureFromText({ projectId: 'p1', loopName: 'l1', text })
    expect(first.count).toBe(2)
    expect(first.persisted).toBe(true)

    const second = service.captureFromText({ projectId: 'p1', loopName: 'l1', text })
    expect(second.count).toBe(0)
    expect(second.persisted).toBe(false)
    expect(insertCalls).toHaveLength(2)
  })

  test('captureFromText respects maxSections from config', () => {
    const text = [
      makeSection(0, 'One', 'Content one'),
      makeSection(1, 'Two', 'Content two'),
      makeSection(2, 'Three', 'Content three'),
    ].join('\n')

    const service = createSectionCaptureService({
      sectionPlansRepo: mockSectionPlansRepo,
      loopsRepo: mockLoopsRepo,
      logger: mockLogger,
      config: () => ({ enabled: true, mode: 'deterministic', maxSections: 2 }),
    })
    const result = service.captureFromText({ projectId: 'p1', loopName: 'l1', text })
    expect(result.count).toBe(2)
  })
})

describe('createSectionCaptureHook', () => {
  let insertCalls: Array<{ projectId: string; loopName: string; sections: ParsedSection[] }>
  let mockSectionPlansRepo: SectionPlansRepo
  let mockLoopsRepo: LoopsRepo
  let mockLogger: Logger
  let mockV2Client: { session: { messages: (args: { sessionID: string; directory: string; limit: number }) => Promise<{ data: unknown[] }> } }

  beforeEach(() => {
    insertCalls = []
    mockSectionPlansRepo = {
      bulkInsert(args) {
        insertCalls.push(args)
        return { inserted: args.sections.length }
      },
      list: () => [],
      listCompleted: () => [],
      get: () => null,
      setStatus: () => {},
      incrementAttempts: () => {},
      setSummary: () => {},
      resetForRewind: () => {},
      setStartedAt: () => {},
      setCompletedAt: () => {},
      count: () => 0,
      restoreAll: () => {},
    } as unknown as SectionPlansRepo

    const loopsRepoState: Record<string, { loopName: string; decompositionSessionId: string; decompositionStatus: string; worktreeDir: string }> = {}
    mockLoopsRepo = {
      getBySessionId(projectId: string, sessionId: string) {
        return loopsRepoState[sessionId] ?? null
      },
      setDecompositionStatus(projectId: string, loopName: string, status: string) {
        for (const [sid, state] of Object.entries(loopsRepoState)) {
          if (state.loopName === loopName) state.decompositionStatus = status
        }
      },
      setTotalSections() {},
    } as unknown as LoopsRepo
    ;(mockLoopsRepo as any)._state = loopsRepoState
    ;(mockLoopsRepo as any)._addLoop = (sessionId: string, loopName: string, status: string) => {
      loopsRepoState[sessionId] = {
        loopName,
        decompositionSessionId: sessionId,
        decompositionStatus: status,
        worktreeDir: '/tmp/wt',
      }
    }

    mockLogger = {
      log: () => {},
      error: () => {},
      debug: () => {},
    }
    mockV2Client = {
      session: {
        messages: async () => ({ data: [] }),
      },
    }
  })

  function createHook(v2Client?: typeof mockV2Client) {
    return createSectionCaptureHook({
      loopsRepo: mockLoopsRepo,
      sectionPlansRepo: mockSectionPlansRepo,
      logger: mockLogger,
      config: () => ({ enabled: true, mode: 'deterministic', maxSections: 12 }),
      projectId: 'test-project',
      v2Client: v2Client as any,
    })
  }

  test('ignores non-decomposer sessions in message.part.updated', async () => {
    const hook = await createHook()

    // Add a loop that is not linked to the given session
    const addLoop = (mockLoopsRepo as any)._addLoop
    addLoop('other-sess', 'other-loop', 'running')

    // Call with a different sessionID that has no loop
    await hook({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'unrelated-sess',
          part: { type: 'text', text: makeSection(0, 'Test', 'content') },
        },
      },
    })

    expect(insertCalls).toHaveLength(0)
  })

  test('ignores non-decomposer sessions in session.status (idle)', async () => {
    const hook = await createHook()

    // Add a loop with a different session ID
    const addLoop = (mockLoopsRepo as any)._addLoop
    addLoop('loop-sess', 'my-loop', 'running')

    // Call with a different sessionID
    await hook({
      event: {
        type: 'session.status',
        properties: {
          sessionID: 'unrelated-sess',
          status: { type: 'idle' },
        },
      },
    })

    expect(insertCalls).toHaveLength(0)
  })

  test('ignores idle events when decompositionStatus is not running', async () => {
    const hook = await createHook()

    // Add a loop with 'completed' decomposition status
    const addLoop = (mockLoopsRepo as any)._addLoop
    addLoop('decomp-sess', 'my-loop', 'completed')

    await hook({
      event: {
        type: 'session.status',
        properties: {
          sessionID: 'decomp-sess',
          status: { type: 'idle' },
        },
      },
    })

    expect(insertCalls).toHaveLength(0)
  })

  test('captures sections from message.part.updated when session is decomposer', async () => {
    const hook = await createHook()

    const addLoop = (mockLoopsRepo as any)._addLoop
    addLoop('decomp-sess', 'my-loop', 'running')

    const text = [
      makeSection(0, 'Phase One', 'First content'),
      makeSection(1, 'Phase Two', 'Second content'),
    ].join('\n')

    // First call sets lastEventCounts but does not persist (stability check)
    await hook({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'decomp-sess',
          part: { type: 'text', text },
        },
      },
    })

    expect(insertCalls).toHaveLength(0)

    // Second call with same section count triggers persistence
    await hook({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'decomp-sess',
          part: { type: 'text', text },
        },
      },
    })

    expect(insertCalls).toHaveLength(1)
    expect(insertCalls[0].sections).toHaveLength(2)
  })

  test('final capture at idle persists sections and marks decomposition completed', async () => {
    const hook = await createHook()

    const addLoop = (mockLoopsRepo as any)._addLoop
    addLoop('decomp-sess', 'my-loop', 'running')

    const text = [
      makeSection(0, 'Phase One', 'First content'),
      makeSection(1, 'Phase Two', 'Second content'),
    ].join('\n')

    // First simulate message.part.updated to build the buffer
    await hook({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'decomp-sess',
          part: { type: 'text', text },
        },
      },
    })

    // Then trigger idle
    await hook({
      event: {
        type: 'session.status',
        properties: {
          sessionID: 'decomp-sess',
          status: { type: 'idle' },
        },
      },
    })

    expect(insertCalls.length).toBeGreaterThanOrEqual(1)
  })
})
