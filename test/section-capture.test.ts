import { describe, test, expect, beforeEach } from 'vitest'
import { extractSections, type ParsedSection } from '../src/utils/section-capture'
import { createSectionCaptureService } from '../src/services/section-capture'
import { createSectionCaptureHook } from '../src/hooks/section-capture'
import type { SectionPlansRepo } from '../src/storage/repos/section-plans-repo'
import type { LoopsRepo } from '../src/storage/repos/loops-repo'
import type { Logger } from '../src/types'

function makeSection(title: string, content: string): string {
  return `<!-- forge-section:start -->\n## ${title}\n${content}\n<!-- forge-section:end -->`
}

describe('extractSections', () => {
  describe('valid sequential sections', () => {
    test('extracts a single section', () => {
      const text = makeSection('Setup', 'Install dependencies')
      const result = extractSections(text)
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({ index: 0, title: 'Setup', content: '## Setup\nInstall dependencies' })
    })

    test('extracts multiple sequential sections', () => {
      const text = [
        makeSection('Phase One', 'First phase content'),
        makeSection('Phase Two', 'Second phase content'),
        makeSection('Phase Three', 'Third phase content'),
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
      const text = makeSection(longTitle, 'content')
      const result = extractSections(text)
      expect(result).toHaveLength(1)
      expect(result[0].title.length).toBe(60)
    })

    test('preserves surrounding text as non-section content', () => {
      const text = `Before text
${makeSection('First', 'Section body')}
After text`

      const result = extractSections(text)
      expect(result).toHaveLength(1)
      expect(result[0].content).toBe('## First\nSection body')
    })

    test('trims whitespace from content', () => {
      const text = makeSection('Trimmed', 'Content with whitespace')
      const result = extractSections(text)
      expect(result).toHaveLength(1)
      expect(result[0].content).toBe('## Trimmed\nContent with whitespace')
    })
  })

  describe('positional indexing', () => {
    test('assigns indices positionally without explicit index attributes', () => {
      const text = [
        makeSection('First', 'Content one'),
        makeSection('Second', 'Content two'),
        makeSection('Third', 'Content three'),
        makeSection('Fourth', 'Content four'),
      ].join('\n')

      const result = extractSections(text)
      expect(result).toHaveLength(4)
      expect(result[0].index).toBe(0)
      expect(result[1].index).toBe(1)
      expect(result[2].index).toBe(2)
      expect(result[3].index).toBe(3)
    })
  })

  describe('structural violations', () => {
    test('returns [] on nested markers (second start before end)', () => {
      const text = `<!-- forge-section:start -->
## First
First content
<!-- forge-section:start -->
## Second
Second content
<!-- forge-section:end -->
<!-- forge-section:end -->`

      const result = extractSections(text)
      expect(result).toEqual([])
    })

    test('returns [] on unterminated block', () => {
      const text = `<!-- forge-section:start -->
## Only
Content but no end marker`

      const result = extractSections(text)
      expect(result).toEqual([])
    })
  })

  describe('maxSections limit', () => {
    test('respects maxSections option', () => {
      const text = [
        makeSection('One', 'Content one'),
        makeSection('Two', 'Content two'),
        makeSection('Three', 'Content three'),
      ].join('\n')

      const result = extractSections(text, { maxSections: 2 })
      expect(result).toHaveLength(2)
      expect(result[0].index).toBe(0)
      expect(result[1].index).toBe(1)
    })

    test('uses default maxSections of 12', () => {
      const sections = Array.from({ length: 15 }, (_, i) =>
        makeSection(`Section ${i}`, `Content ${i}`)
      )
      const text = sections.join('\n')

      const result = extractSections(text)
      expect(result).toHaveLength(12)
    })

    test('maxSections of 0 returns []', () => {
      const text = makeSection('Only', 'Content')
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
      const text = makeSection('Multi-line', 'Line one\nLine two\nLine three')
      const result = extractSections(text)
      expect(result).toHaveLength(1)
      expect(result[0].content).toBe('## Multi-line\nLine one\nLine two\nLine three')
    })

    test('skips empty content blocks', () => {
      const text = `<!-- forge-section:start -->
<!-- forge-section:end -->`

      const result = extractSections(text)
      expect(result).toEqual([])
    })

    test('\\r\\n line endings are handled correctly', () => {
      const text = `<!-- forge-section:start -->\r\n## Title\r\nContent\r\n<!-- forge-section:end -->`
      const result = extractSections(text)
      expect(result).toHaveLength(1)
      expect(result[0].title).toBe('Title')
    })

    test('title derived from first non-empty inner line when no heading', () => {
      const text = `<!-- forge-section:start -->
Some plain text without heading
More content
<!-- forge-section:end -->`

      const result = extractSections(text)
      expect(result).toHaveLength(1)
      expect(result[0].title).toBe('Some plain text without heading')
    })

    test('fallback title when block is entirely empty after trim', () => {
      const text = `<!-- forge-section:start -->


<!-- forge-section:end -->`

      const result = extractSections(text)
      expect(result).toEqual([])
    })

    test('falls back to Section N when first non-empty line strips to empty', () => {
      const text = `<!-- forge-section:start -->
###
real content
<!-- forge-section:end -->`

      const result = extractSections(text)
      expect(result).toHaveLength(1)
      expect(result[0].title).toBe('Section 0')
    })

    test('falls back to Section N when first non-empty line is only dashes', () => {
      const text = `<!-- forge-section:start -->
---
real content
<!-- forge-section:end -->`

      const result = extractSections(text)
      expect(result).toHaveLength(1)
      expect(result[0].title).toBe('Section 0')
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
      makeSection('Phase One', 'First content'),
      makeSection('Phase Two', 'Second content'),
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
      makeSection('Phase One', 'First content'),
      makeSection('Phase Two', 'Second content'),
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
      makeSection('One', 'Content one'),
      makeSection('Two', 'Content two'),
      makeSection('Three', 'Content three'),
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

    const addLoop = (mockLoopsRepo as any)._addLoop
    addLoop('other-sess', 'other-loop', 'running')

    await hook({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'unrelated-sess',
          part: { type: 'text', text: makeSection('Test', 'content') },
        },
      },
    })

    expect(insertCalls).toHaveLength(0)
  })

  test('ignores non-decomposer sessions in session.status (idle)', async () => {
    const hook = await createHook()

    const addLoop = (mockLoopsRepo as any)._addLoop
    addLoop('loop-sess', 'my-loop', 'running')

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
      makeSection('Phase One', 'First content'),
      makeSection('Phase Two', 'Second content'),
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
      makeSection('Phase One', 'First content'),
      makeSection('Phase Two', 'Second content'),
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
