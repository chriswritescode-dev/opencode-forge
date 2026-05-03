import { describe, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createFallowTools, FALLOW_DEFAULT_TOOL_NAMES, type FallowLoader } from '../src/tools/fallow'
import type { ToolContext } from '../src/tools/types'
import type { PluginConfig } from '../src/types'

function fakeFallow(spy: { calls: Array<{ fn: string; opts: unknown }> }) {
  const make = (fn: string, payload: object) =>
    async (opts: unknown) => {
      spy.calls.push({ fn, opts })
      return { schema_version: 1, version: 'test', elapsed_ms: 1, ...payload }
    }
  return {
    detectDeadCode: make('detectDeadCode', { total_issues: 3, summary: {}, unused_files: [], unused_exports: [], unused_types: [], private_type_leaks: [], unused_dependencies: [], unused_dev_dependencies: [], unused_optional_dependencies: [], unused_enum_members: [], unused_class_members: [], unresolved_imports: [], unlisted_dependencies: [], duplicate_exports: [], type_only_dependencies: [], test_only_dependencies: [], circular_dependencies: [], boundary_violations: [], stale_suppressions: [] }),
    detectCircularDependencies: make('detectCircularDependencies', { total_issues: 0, summary: {}, unused_files: [], unused_exports: [], unused_types: [], private_type_leaks: [], unused_dependencies: [], unused_dev_dependencies: [], unused_optional_dependencies: [], unused_enum_members: [], unused_class_members: [], unresolved_imports: [], unlisted_dependencies: [], duplicate_exports: [], type_only_dependencies: [], test_only_dependencies: [], circular_dependencies: [], boundary_violations: [], stale_suppressions: [] }),
    detectBoundaryViolations: make('detectBoundaryViolations', { total_issues: 0, summary: {}, unused_files: [], unused_exports: [], unused_types: [], private_type_leaks: [], unused_dependencies: [], unused_dev_dependencies: [], unused_optional_dependencies: [], unused_enum_members: [], unused_class_members: [], unresolved_imports: [], unlisted_dependencies: [], duplicate_exports: [], type_only_dependencies: [], test_only_dependencies: [], circular_dependencies: [], boundary_violations: [], stale_suppressions: [] }),
    detectDuplication: make('detectDuplication', { clone_groups: [{ instances: [], token_count: 10, line_count: 3 }], stats: { total_files: 1, files_with_clones: 1, total_lines: 100, duplicated_lines: 3, total_tokens: 1000, duplicated_tokens: 10, clone_groups: 1, clone_instances: 0, duplication_percentage: 3.0 } }),
    computeHealth: make('computeHealth', { findings: [{ path: 'a.ts', name: 'foo', line: 1, col: 1, cyclomatic: 5, cognitive: 5, line_count: 10, param_count: 1, exceeded: 'cyclomatic', severity: 'warn' }], summary: {} }),
    computeComplexity: make('computeComplexity', { findings: [], summary: {} }),
  } as unknown as ReturnType<FallowLoader>
}

function makeCtx(config: PluginConfig): ToolContext {
  // Minimal ToolContext stub; only fields read by createFallowTools are populated.
  return {
    projectId: 'p1',
    directory: '/tmp/forge-test',
    config,
    logger: { log() {}, error() {}, debug() {} },
    db: {} as unknown as Database,
    dataDir: '/tmp',
    loopService: {} as never,
    loopHandler: {} as never,
    v2: {} as never,
    cleanup: async () => {},
    input: {} as never,
    sandboxManager: null,
    plansRepo: {} as never,
    reviewFindingsRepo: {} as never,
    loopsRepo: {} as never,
  }
}

describe('createFallowTools', () => {
  test('registers all six tools by default', () => {
    const ctx = makeCtx({})
    const tools = createFallowTools(ctx)
    expect(Object.keys(tools).sort()).toEqual([...FALLOW_DEFAULT_TOOL_NAMES].sort())
  })

  test('returns no tools when fallow.enabled is false', () => {
    const ctx = makeCtx({ fallow: { enabled: false } })
    const tools = createFallowTools(ctx)
    expect(Object.keys(tools)).toEqual([])
  })

  test('honors allowedTools whitelist', () => {
    const ctx = makeCtx({ fallow: { allowedTools: ['fallow-dead-code', 'fallow-dupes'] } })
    const tools = createFallowTools(ctx)
    expect(Object.keys(tools).sort()).toEqual(['fallow-dead-code', 'fallow-dupes'])
  })

  test('fallow-dead-code calls detectDeadCode with root and forwards args', async () => {
    const ctx = makeCtx({})
    const spy = { calls: [] as Array<{ fn: string; opts: unknown }> }
    const tools = createFallowTools(ctx, { loader: async () => fakeFallow(spy) })
    const out = await tools['fallow-dead-code']!.execute(
      { production: true, changedSince: 'main' } as never,
      { directory: '/tmp/from-toolctx', sessionID: 's', messageID: 'm', agent: 'code', worktree: '/tmp/wt', abort: new AbortController().signal, metadata: () => {}, ask: (() => {}) as never },
    )
    expect(spy.calls.length).toBe(1)
    expect(spy.calls[0]!.fn).toBe('detectDeadCode')
    expect(spy.calls[0]!.opts).toMatchObject({ root: '/tmp/from-toolctx', explain: true, production: true, changedSince: 'main' })
    expect(typeof out === 'string' ? out : out.output).toContain('dead-code: 3 items')
  })

  test('fallow-dupes counts clone_groups in summary header', async () => {
    const ctx = makeCtx({})
    const spy = { calls: [] as Array<{ fn: string; opts: unknown }> }
    const tools = createFallowTools(ctx, { loader: async () => fakeFallow(spy) })
    const out = await tools['fallow-dupes']!.execute(
      { mode: 'strict' } as never,
      { directory: '/tmp/x', sessionID: 's', messageID: 'm', agent: 'code', worktree: '/tmp/x', abort: new AbortController().signal, metadata: () => {}, ask: (() => {}) as never },
    )
    expect(spy.calls[0]!.fn).toBe('detectDuplication')
    expect(spy.calls[0]!.opts).toMatchObject({ mode: 'strict' })
    expect(typeof out === 'string' ? out : out.output).toContain('dupes: 1 item')
  })

  test('fallow-health counts findings in summary header', async () => {
    const ctx = makeCtx({})
    const spy = { calls: [] as Array<{ fn: string; opts: unknown }> }
    const tools = createFallowTools(ctx, { loader: async () => fakeFallow(spy) })
    const out = await tools['fallow-health']!.execute(
      { score: true } as never,
      { directory: '/tmp/x', sessionID: 's', messageID: 'm', agent: 'code', worktree: '/tmp/x', abort: new AbortController().signal, metadata: () => {}, ask: (() => {}) as never },
    )
    expect(spy.calls[0]!.fn).toBe('computeHealth')
    expect(typeof out === 'string' ? out : out.output).toContain('health: 1 item')
  })

  test('falls back to ctx.directory when toolCtx has no directory', async () => {
    const ctx = makeCtx({})
    const spy = { calls: [] as Array<{ fn: string; opts: unknown }> }
    const tools = createFallowTools(ctx, { loader: async () => fakeFallow(spy) })
    await tools['fallow-circular-deps']!.execute(
      {} as never,
      { sessionID: 's', messageID: 'm', agent: 'code', directory: undefined, worktree: undefined, abort: new AbortController().signal, metadata: () => {}, ask: (() => {}) as never } as never,
    )
    // When toolCtx.directory is undefined, resolveRoot falls through to ctx.directory.
    expect(spy.calls[0]!.opts).toMatchObject({ root: '/tmp/forge-test' })
  })

  test('wraps loader failures with an actionable error', async () => {
    const ctx = makeCtx({})
    const tools = createFallowTools(ctx, {
      loader: async () => { throw new Error('Cannot find native binding') },
    })
    await expect(tools['fallow-dead-code']!.execute(
      {} as never,
      { directory: '/tmp', sessionID: 's', messageID: 'm', agent: 'code', worktree: '/tmp', abort: new AbortController().signal, metadata: () => {}, ask: (() => {}) as never },
    )).rejects.toThrow(/Failed to load @fallow-cli\/fallow-node/)
  })
})
