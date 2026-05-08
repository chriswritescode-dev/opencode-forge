import { describe, test, expect, beforeEach } from 'vitest'
import { extractSections, type ParsedSection } from '../src/utils/section-capture'
import { createSectionCaptureHook } from '../src/hooks/section-capture'
import type { SectionPlansRepo } from '../src/storage/repos/section-plans-repo'
import type { LoopsRepo } from '../src/storage/repos/loops-repo'
import type { Logger } from '../src/types'

describe('Streaming completion behavior', () => {
  function makeSection(title: string, content: string): string {
    return `<!-- forge-section:start -->\n## ${title}\n${content}\n<!-- forge-section:end -->`
  }

  describe('extractSections from streaming buffer', () => {
    test('extracts sections from partial streaming buffer', () => {
      const text = makeSection('Setup', 'Install deps')
      const result = extractSections(text)
      expect(result).toHaveLength(1)
      expect(result[0].title).toBe('Setup')
    })

    test('handles streaming buffer with trailing text', () => {
      const text = [
        'Some intro text',
        makeSection('First', 'Content first'),
        'Still streaming...',
      ].join('\n')

      const result = extractSections(text)
      expect(result).toHaveLength(1)
      expect(result[0].title).toBe('First')
    })

    test('handles multiple sections in streaming buffer', () => {
      const text = [
        makeSection('Phase One', 'Content one'),
        makeSection('Phase Two', 'Content two'),
      ].join('\n')

      const result = extractSections(text)
      expect(result).toHaveLength(2)
      expect(result[0].index).toBe(0)
      expect(result[1].index).toBe(1)
    })

    test('returns empty when streaming buffer has no markers', () => {
      const text = 'Just some random text being streamed'

      const result = extractSections(text)
      expect(result).toEqual([])
    })

    test('\\r\\n line endings are handled during streaming', () => {
      const text = '<!-- forge-section:start -->\r\n## Title\r\nContent\r\n<!-- forge-section:end -->'
      const result = extractSections(text)
      expect(result).toHaveLength(1)
      expect(result[0].title).toBe('Title')
    })
  })
})

describe('createSectionCaptureHook - streaming completion', () => {
  let insertCalls: Array<{ projectId: string; loopName: string; sections: ParsedSection[] }>
  let updateCalls: Array<{ projectId: string; loopName: string; sections: ParsedSection[] }>
  let statusCalls: Array<{ projectId: string; loopName: string; status: string }>
  let totalSectionsCalls: Array<{ projectId: string; loopName: string; count: number }>
  let mockSectionPlansRepo: SectionPlansRepo
  let mockLoopsRepo: LoopsRepo
  let mockLogger: Logger

  function makeSection(title: string, content: string): string {
    return `<!-- forge-section:start -->\n## ${title}\n${content}\n<!-- forge-section:end -->`
  }

  beforeEach(() => {
    insertCalls = []
    updateCalls = []
    statusCalls = []
    totalSectionsCalls = []

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
      updateContent(projectId: string, loopName: string, sections: ParsedSection[]) {
        updateCalls.push({ projectId, loopName, sections })
        return { updated: sections.length }
      },
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
        statusCalls.push({ projectId, loopName, status })
      },
      setTotalSections(projectId: string, loopName: string, count: number) {
        totalSectionsCalls.push({ projectId, loopName, count })
      },
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
  })

  function createHook() {
    return createSectionCaptureHook({
      loopsRepo: mockLoopsRepo,
      sectionPlansRepo: mockSectionPlansRepo,
      logger: mockLogger,
      config: () => ({ enabled: true, mode: 'deterministic', maxSections: 12 }),
      projectId: 'test-project',
    })
  }

  test('streaming completion persists sections and marks completed', async () => {
    const hook = createHook()

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

    // Second call with same section count triggers persistence and marks completed
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
    expect(statusCalls).toHaveLength(1)
    expect(statusCalls[0].status).toBe('completed')
    expect(totalSectionsCalls).toHaveLength(1)
    expect(totalSectionsCalls[0].count).toBe(2)
  })

  test('streaming completion allows later sections to be persisted', async () => {
    const hook = createHook()

    const addLoop = (mockLoopsRepo as any)._addLoop
    addLoop('decomp-sess', 'my-loop', 'running')

    const text1 = [makeSection('Phase One', 'First content')].join('\n')

    // First call sets lastEventCounts
    await hook({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'decomp-sess',
          part: { type: 'text', text: text1 },
        },
      },
    })

    // Second call persists section 1 and marks completed
    await hook({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'decomp-sess',
          part: { type: 'text', text: text1 },
        },
      },
    })

    expect(insertCalls).toHaveLength(1)
    expect(statusCalls).toHaveLength(1)
    expect(statusCalls[0].status).toBe('completed')

    // Third call with section 2 added - should still persist additional sections
    const text2 = [
      makeSection('Phase One', 'First content'),
      makeSection('Phase Two', 'Second content'),
    ].join('\n')

    // First event with new count sets lastEventCounts
    await hook({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'decomp-sess',
          part: { type: 'text', text: text2 },
        },
      },
    })

    // Second event with same count persists new sections
    await hook({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'decomp-sess',
          part: { type: 'text', text: text2 },
        },
      },
    })

    expect(insertCalls).toHaveLength(2)
    expect(insertCalls[1].sections).toHaveLength(2)
    // Total sections should have been updated again
    expect(totalSectionsCalls).toHaveLength(2)
    expect(totalSectionsCalls[1].count).toBe(2)
  })

  test('idle does not clobber already completed decomposition', async () => {
    const hook = createHook()

    const addLoop = (mockLoopsRepo as any)._addLoop
    addLoop('decomp-sess', 'my-loop', 'running')

    const text = [makeSection('Phase One', 'First content')].join('\n')

    // Streaming persists and marks completed
    await hook({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'decomp-sess',
          part: { type: 'text', text },
        },
      },
    })

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
    expect(statusCalls).toHaveLength(1)

    const statusCallsBeforeIdle = statusCalls.length

    // Idle should not write a second completion status
    await hook({
      event: {
        type: 'session.status',
        properties: {
          sessionID: 'decomp-sess',
          status: { type: 'idle' },
        },
      },
    })

    // No new completion status calls should have been made
    expect(statusCalls).toHaveLength(statusCallsBeforeIdle)
    // But it should still process and potentially update content
  })

  test('failed status only set when no sections exist and not already completed', async () => {
    const hook = createHook()

    const addLoop = (mockLoopsRepo as any)._addLoop
    addLoop('decomp-sess', 'my-loop', 'running')

    // Idle with no sections and no prior streaming should mark failed
    await hook({
      event: {
        type: 'session.status',
        properties: {
          sessionID: 'decomp-sess',
          status: { type: 'idle' },
        },
      },
    })

    expect(statusCalls).toHaveLength(1)
    expect(statusCalls[0].status).toBe('failed')
  })

  test('idle after streaming completion does not mark failed even with no additional sections', async () => {
    const hook = createHook()

    const addLoop = (mockLoopsRepo as any)._addLoop
    addLoop('decomp-sess', 'my-loop', 'running')

    const text = [makeSection('Phase One', 'First content')].join('\n')

    // Streaming persists and marks completed
    await hook({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'decomp-sess',
          part: { type: 'text', text },
        },
      },
    })

    await hook({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'decomp-sess',
          part: { type: 'text', text },
        },
      },
    })

    const statusCallsAfterStreaming = statusCalls.length

    // Idle with empty buffer (no additional sections) but already completed
    await hook({
      event: {
        type: 'session.status',
        properties: {
          sessionID: 'decomp-sess',
          status: { type: 'idle' },
        },
      },
    })

    // No new failed status should be written because decomposition was already completed
    expect(statusCalls.filter(s => s.status === 'failed')).toHaveLength(0)
    expect(statusCalls).toHaveLength(statusCallsAfterStreaming)
  })
})
