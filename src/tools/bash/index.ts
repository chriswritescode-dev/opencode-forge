import { tool } from '@opencode-ai/plugin'
import path from 'path'
import type { Logger } from '../../types'
import type { SandboxContext } from '../../sandbox/context'
import { parseBash } from './parse'
import { collect } from './collect'
import { renderDescription, PARAM_DESCRIPTION } from './prompt'
import { MAX_LINES, MAX_BYTES } from './truncate'
import type { Limits } from './truncate'
import { runOnHost } from './exec-host'
import { runInSandbox } from './exec-sandbox'

const z = tool.schema

export interface BashToolDeps {
  resolveSandboxForSession: (sessionID: string) => Promise<SandboxContext | null>
  logger: Logger
  dataDir: string
  limits?: Limits
}

export function createBashTool(deps: BashToolDeps): ReturnType<typeof tool> {
  const limits = deps.limits ?? { maxLines: MAX_LINES, maxBytes: MAX_BYTES }
  return tool({
    description: renderDescription(limits),
    args: {
      command: z.string().describe('The command to execute'),
      timeout: z.number().int().positive().optional().describe('Optional timeout in milliseconds'),
      workdir: z.string().optional().describe('Working directory to run the command in. Use this instead of `cd`.'),
      description: z.string().describe(PARAM_DESCRIPTION),
    },
    execute: async (args, ctx) => {
      const cwd = args.workdir ? path.resolve(ctx.directory, args.workdir) : ctx.directory
      const root = await parseBash(args.command)
      const scan = collect(root, cwd)

      // Collect all external directories that need authorization
      const externalDirs = new Set<string>()

      // If workdir is outside ctx.directory, it needs external_directory permission
      if (args.workdir) {
        const rel = path.relative(ctx.directory, cwd)
        if (rel.startsWith('..')) {
          externalDirs.add(cwd)
        }
      }

      for (const d of scan.dirs) {
        externalDirs.add(d)
      }

      if (externalDirs.size > 0) {
        const globs = Array.from(externalDirs).map(d => `${d}/*`)
        await ctx.ask({ permission: 'external_directory', patterns: globs, always: globs, metadata: {} })
      }
      if (scan.patterns.length > 0) {
        await ctx.ask({ permission: 'bash', patterns: scan.patterns, always: scan.always, metadata: {} })
      }

      const sandbox = await deps.resolveSandboxForSession(ctx.sessionID)
      return sandbox
        ? await runInSandbox(args, sandbox, deps, ctx, limits)
        : await runOnHost(args, deps, ctx, limits, cwd)
    },
  })
}
