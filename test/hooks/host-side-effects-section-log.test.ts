import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { performTerminationSideEffects } from '../../src/hooks/host-side-effects'
import { formatDateKey } from '../../src/services/worktree-log'
import type { LoopState, TerminationReason } from '../../src/loop'
import type { PluginConfig } from '../../src/types'
import type { SectionDigestEntry } from '../../src/loop/prompts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildState(overrides?: Partial<LoopState>): LoopState {
  return {
    phase: 'coding',
    active: false,
    sessionId: 'sess_worktree',
    hostSessionId: 'sess_host',
    loopName: 'feat-x',
    worktreeDir: '/tmp/wt/feat-x',
    projectDir: '/tmp/project',
    worktreeBranch: 'forge/feat-x',
    iteration: 3,
    maxIterations: 10,
    startedAt: new Date().toISOString(),
    errorCount: 0,
    auditCount: 0,
    currentSectionIndex: 0,
    totalSections: 2,
    finalAuditDone: false,
    worktree: true,
    workspaceId: 'ws_abc',
    ...overrides,
  } as LoopState
}

const completed: TerminationReason = { kind: 'completed' }

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('performTerminationSideEffects section logging', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = join('/tmp', 'forge-section-log-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))
    mkdirSync(tempDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  function buildCtx(overrides?: {
    tuiPublish?: ReturnType<typeof vi.fn>
    workspaceRemove?: ReturnType<typeof vi.fn>
    log?: ReturnType<typeof vi.fn>
    error?: ReturnType<typeof vi.fn>
    getSectionDigest?: (state: LoopState) => SectionDigestEntry[]
  }) {
    const tuiPublish = overrides?.tuiPublish ?? vi.fn().mockResolvedValue({ data: {} })
    const workspaceRemove = overrides?.workspaceRemove ?? vi.fn().mockResolvedValue({ data: {} })
    const log = overrides?.log ?? vi.fn()
    const error = overrides?.error ?? vi.fn()

    return {
      ctx: {
        v2Client: {
          tui: { publish: tuiPublish },
          experimental: { workspace: { remove: workspaceRemove } },
        } as never,
        logger: { log, error, debug: () => {} },
        getConfig: () => ({
          loop: {
            worktreeLogging: {
              enabled: true,
              directory: tempDir,
            },
          },
        }) as PluginConfig,
        getSectionDigest: overrides?.getSectionDigest,
      },
      tuiPublish,
      workspaceRemove,
      log,
      error,
    }
  }

  test('writes section summaries when getSectionDigest provides entries', async () => {
    const sectionDigest: SectionDigestEntry[] = [
      {
        index: 0,
        title: 'Auth',
        summaryDone: 'Added login flow',
        summaryDeviations: 'None',
        summaryFollowUps: 'Add tests',
      },
    ]
    const { ctx } = buildCtx({ getSectionDigest: () => sectionDigest })

    await performTerminationSideEffects(buildState(), completed, 'sess_worktree', ctx)

    const dateKey = formatDateKey(new Date())
    const logFile = join(tempDir, `${dateKey}.md`)
    expect(existsSync(logFile)).toBe(true)

    const content = readFileSync(logFile, 'utf-8')
    expect(content).toContain('### Sections')
    expect(content).toContain('#### Section 1: Auth')
    expect(content).toContain('Added login flow')
    expect(content).toContain('### Plan')
  })

  test('omits Sections block when digest is empty', async () => {
    const { ctx } = buildCtx({ getSectionDigest: () => [] })

    await performTerminationSideEffects(buildState(), completed, 'sess_worktree', ctx)

    const dateKey = formatDateKey(new Date())
    const logFile = join(tempDir, `${dateKey}.md`)
    expect(existsSync(logFile)).toBe(true)

    const content = readFileSync(logFile, 'utf-8')
    expect(content).not.toContain('### Sections')
    expect(content).toContain('### Plan')
  })

  test('no getSectionDigest provided does not crash and omits Sections block', async () => {
    const { ctx } = buildCtx() // no getSectionDigest

    await performTerminationSideEffects(buildState(), completed, 'sess_worktree', ctx)

    const dateKey = formatDateKey(new Date())
    const logFile = join(tempDir, `${dateKey}.md`)
    expect(existsSync(logFile)).toBe(true)

    const content = readFileSync(logFile, 'utf-8')
    expect(content).not.toContain('### Sections')
    expect(content).toContain('### Plan')
  })
})
