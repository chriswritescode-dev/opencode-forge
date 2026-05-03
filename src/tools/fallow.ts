import { tool } from '@opencode-ai/plugin'
import type { ToolContext } from './types'

const z = tool.schema

// Type-only import; runtime import is lazy.
import type * as FallowNode from '@fallow-cli/fallow-node'

type FallowModule = typeof FallowNode

export type FallowLoader = () => Promise<FallowModule>

const DEFAULT_TOOL_NAMES = [
  'fallow-dead-code',
  'fallow-circular-deps',
  'fallow-boundary-violations',
  'fallow-dupes',
  'fallow-health',
  'fallow-complexity',
] as const

export type FallowToolName = typeof DEFAULT_TOOL_NAMES[number]

const defaultLoader: FallowLoader = async () => {
  return await import('@fallow-cli/fallow-node')
}

export interface CreateFallowToolsOptions {
  /** Override the NAPI loader (used by tests). */
  loader?: FallowLoader
}

export function createFallowTools(
  ctx: ToolContext,
  opts: CreateFallowToolsOptions = {},
): Record<string, ReturnType<typeof tool>> {
  const cfg = ctx.config.fallow ?? {}
  const enabled = cfg.enabled ?? true
  if (!enabled) return {}

  const allow = cfg.allowedTools && cfg.allowedTools.length > 0
    ? new Set(cfg.allowedTools)
    : new Set<string>(DEFAULT_TOOL_NAMES)

  const loader = opts.loader ?? defaultLoader
  let cached: FallowModule | null = null
  const loadFallow = async (): Promise<FallowModule> => {
    if (cached) return cached
    try {
      cached = await loader()
      return cached
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Failed to load @fallow-cli/fallow-node native bindings: ${msg}. ` +
        `Install @fallow-cli/fallow-node and ensure the platform-specific native package resolved.`,
        { cause: err },
      )
    }
  }

  const resolveRoot = (toolCtx?: { directory?: string; worktree?: string }): string =>
    toolCtx?.directory ?? toolCtx?.worktree ?? ctx.directory

  const finalize = (label: string, report: { total_issues?: number; clone_groups?: unknown[]; findings?: unknown[]; elapsed_ms?: number }): string => {
    const issues =
      typeof report.total_issues === 'number' ? report.total_issues
      : Array.isArray(report.clone_groups) ? report.clone_groups.length
      : Array.isArray(report.findings) ? report.findings.length
      : 0
    const ms = typeof report.elapsed_ms === 'number' ? `${report.elapsed_ms}ms` : 'n/a'
    const header = `${label}: ${issues} item${issues === 1 ? '' : 's'} in ${ms}`
    return `${header}\n${JSON.stringify(report, null, 2)}`
  }

  const tools: Record<string, ReturnType<typeof tool>> = {}

  if (allow.has('fallow-dead-code')) {
    tools['fallow-dead-code'] = tool({
      description:
        'Find unused exports, unused files, unused dependencies, unresolved imports, duplicate exports, and other dead-code issues. Use for unused exports/files/deps, unresolved imports, duplicate exports, circular deps, boundary violations, and stale suppressions. Pass `files` for one-file scope, `changedSince` for diff scope, `workspace` for monorepo scope. Returns the full DeadCodeReport JSON.',
      args: {
        production: z.boolean().optional().describe('Exclude tests, stories, dev files'),
        changedSince: z.string().optional().describe('Limit to files changed since this git ref (e.g. "main", "HEAD~5")'),
        workspace: z.array(z.string()).optional().describe('Scope to one or more workspaces (package names or globs)'),
        unusedExports: z.boolean().optional().describe('Toggle the unused-exports check'),
        unusedFiles: z.boolean().optional().describe('Toggle the unused-files check'),
        unusedDeps: z.boolean().optional().describe('Toggle the unused-dependencies check'),
        circularDeps: z.boolean().optional().describe('Toggle the circular-dependencies check'),
        boundaryViolations: z.boolean().optional().describe('Toggle the boundary-violations check'),
        files: z.array(z.string()).optional().describe('Scope to specific files (relative to root)'),
        includeEntryExports: z.boolean().optional().describe('Include exports from declared entry files when computing unused exports'),
      },
      execute: async (args, toolCtx) => {
        const f = await loadFallow()
        const report = await f.detectDeadCode({
          root: resolveRoot(toolCtx),
          explain: true,
          ...args,
        })
        return finalize('dead-code', report)
      },
    })
  }

  if (allow.has('fallow-circular-deps')) {
    tools['fallow-circular-deps'] = tool({
      description:
        'Find only circular dependency cycles. Faster than `fallow-dead-code` when cycles are the only question. Pass `changedSince` to scope to a diff, `workspace` to scope to one or more packages.',
      args: {
        production: z.boolean().optional().describe('Exclude tests, stories, dev files'),
        changedSince: z.string().optional().describe('Limit to files changed since this git ref (e.g. "main", "HEAD~5")'),
        workspace: z.array(z.string()).optional().describe('Scope to one or more workspaces (package names or globs)'),
      },
      execute: async (args, toolCtx) => {
        const f = await loadFallow()
        const report = await f.detectCircularDependencies({
          root: resolveRoot(toolCtx),
          explain: true,
          ...args,
        })
        return finalize('circular-deps', report)
      },
    })
  }

  if (allow.has('fallow-boundary-violations')) {
    tools['fallow-boundary-violations'] = tool({
      description:
        'Find architecture boundary violations — imports that cross declared zone rules. Use to verify a change does not punch through an enforced boundary. Pass `changedSince` to scope to a diff.',
      args: {
        production: z.boolean().optional().describe('Exclude tests, stories, dev files'),
        changedSince: z.string().optional().describe('Limit to files changed since this git ref (e.g. "main", "HEAD~5")'),
        workspace: z.array(z.string()).optional().describe('Scope to one or more workspaces (package names or globs)'),
      },
      execute: async (args, toolCtx) => {
        const f = await loadFallow()
        const report = await f.detectBoundaryViolations({
          root: resolveRoot(toolCtx),
          explain: true,
          ...args,
        })
        return finalize('boundary-violations', report)
      },
    })
  }

  if (allow.has('fallow-dupes')) {
    tools['fallow-dupes'] = tool({
      description:
        'Find duplicated code blocks (clone groups). Use to catch logic that re-implements existing code. `mode` controls strictness (`strict` for exact matches, `mild` for near-clones, `weak`/`semantic` for fuzzier detection). Tighten with `minTokens`/`minLines`; widen with `threshold`. Returns DuplicationReport JSON.',
      args: {
        mode: z.enum(['strict', 'mild', 'weak', 'semantic']).optional().describe('Detection mode (default: mild)'),
        minTokens: z.number().int().positive().optional().describe('Minimum token length for a clone candidate'),
        minLines: z.number().int().positive().optional().describe('Minimum line count for a clone candidate'),
        threshold: z.number().optional().describe('Similarity threshold (0..1) for `mild`/`weak`/`semantic` modes'),
        skipLocal: z.boolean().optional().describe('Skip clones within the same file'),
        crossLanguage: z.boolean().optional().describe('Enable cross-language clone detection'),
        ignoreImports: z.boolean().optional().describe('Ignore import statements in clone detection'),
        top: z.number().int().positive().optional().describe('Return only the top N clone groups by size'),
        production: z.boolean().optional().describe('Exclude tests, stories, dev files'),
        changedSince: z.string().optional().describe('Limit to files changed since this git ref (e.g. "main", "HEAD~5")'),
        workspace: z.array(z.string()).optional().describe('Scope to one or more workspaces (package names or globs)'),
      },
      execute: async (args, toolCtx) => {
        const f = await loadFallow()
        const report = await f.detectDuplication({
          root: resolveRoot(toolCtx),
          explain: true,
          ...args,
        })
        return finalize('dupes', report)
      },
    })
  }

  if (allow.has('fallow-health')) {
    tools['fallow-health'] = tool({
      description:
        'Compute code health: complexity findings, vital signs, file scores, hotspots, refactor targets. Use when reviewing complexity hotspots or grading a file. Pass `changedSince` for a diff-scoped report; pass `top: N` to limit findings. Returns HealthReport JSON.',
      args: {
        top: z.number().int().positive().optional().describe('Top N most complex (default: all over threshold)'),
        sort: z.enum(['cyclomatic', 'cognitive', 'lines', 'severity']).optional().describe('Sort order for findings'),
        score: z.boolean().optional().describe('Include 0-100 health score with letter grade'),
        fileScores: z.boolean().optional().describe('Include per-file health scores'),
        hotspots: z.boolean().optional().describe('Include complexity hotspot analysis'),
        targets: z.boolean().optional().describe('Include refactor targets'),
        effort: z.enum(['low', 'medium', 'high']).optional().describe('Filter targets by effort level'),
        maxCyclomatic: z.number().int().positive().optional().describe('Maximum cyclomatic complexity threshold'),
        maxCognitive: z.number().int().positive().optional().describe('Maximum cognitive complexity threshold'),
        maxCrap: z.number().int().positive().optional().describe('Maximum CRAP score threshold'),
        production: z.boolean().optional().describe('Exclude tests, stories, dev files'),
        changedSince: z.string().optional().describe('Limit to files changed since this git ref (e.g. "main", "HEAD~5")'),
        workspace: z.array(z.string()).optional().describe('Scope to one or more workspaces (package names or globs)'),
      },
      execute: async (args, toolCtx) => {
        const f = await loadFallow()
        const report = await f.computeHealth({
          root: resolveRoot(toolCtx),
          explain: true,
          ...args,
        })
        return finalize('health', report)
      },
    })
  }

  if (allow.has('fallow-complexity')) {
    tools['fallow-complexity'] = tool({
      description:
        'Compute per-function complexity (cyclomatic + cognitive) without vital-signs overhead. Use fallow-health when you need vital signs/score; use this for raw findings only. Returns per-function cyclomatic + cognitive complexity findings only — no vital signs, no scores.',
      args: {
        top: z.number().int().positive().optional().describe('Top N most complex functions'),
        sort: z.enum(['cyclomatic', 'cognitive', 'lines', 'severity']).optional().describe('Sort order for findings'),
        maxCyclomatic: z.number().int().positive().optional().describe('Maximum cyclomatic complexity threshold'),
        maxCognitive: z.number().int().positive().optional().describe('Maximum cognitive complexity threshold'),
        production: z.boolean().optional().describe('Exclude tests, stories, dev files'),
        changedSince: z.string().optional().describe('Limit to files changed since this git ref (e.g. "main", "HEAD~5")'),
        workspace: z.array(z.string()).optional().describe('Scope to one or more workspaces (package names or globs)'),
      },
      execute: async (args, toolCtx) => {
        const f = await loadFallow()
        const report = await f.computeComplexity({
          root: resolveRoot(toolCtx),
          explain: true,
          ...args,
        })
        return finalize('complexity', report)
      },
    })
  }

  return tools
}

export const FALLOW_DEFAULT_TOOL_NAMES = DEFAULT_TOOL_NAMES
