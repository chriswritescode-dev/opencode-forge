import { tool } from '@opencode-ai/plugin'
import type { Logger } from '../../types'
import type { SandboxContext } from '../../sandbox/context'
import { renderDescription, PARAM_DESCRIPTION } from './prompt'
import { MAX_LINES, MAX_BYTES } from './truncate'
import type { Limits } from './truncate'
import { runInSandbox } from './exec-sandbox'

const z = tool.schema

export interface BashToolDeps {
  resolveSandboxForSession: (sessionID: string) => Promise<SandboxContext | null>
  logger: Logger
  limits?: Limits
  /**
   * Path the description should advertise for scratch work. Defaults to the
   * OS tmp dir. Sandbox-required tools should pass a workspace-relative path
   * because `/tmp` differs between the host and the loop container.
   */
  tmpDir?: string
}

export function createBashTool(deps: BashToolDeps): ReturnType<typeof tool> {
  const limits = deps.limits ?? { maxLines: MAX_LINES, maxBytes: MAX_BYTES }
  return tool({
    description: renderDescription(limits, { tmpDir: deps.tmpDir }),
    args: {
      command: z.string().describe('The command to execute'),
      timeout: z.number().int().positive().optional().describe('Optional timeout in milliseconds'),
      workdir: z.string().optional().describe('Working directory to run the command in. Use this instead of `cd`.'),
      description: z.string().describe(PARAM_DESCRIPTION),
    },
    execute: async (args, ctx) => {
      const sandbox = await deps.resolveSandboxForSession(ctx.sessionID)
      if (!sandbox) {
        throw new Error('sh is only available inside an active Forge loop session sandbox')
      }
      // Loop-session membership is enforced above; sh does not consult
      // the permission system because loops cannot answer 'ask' prompts and any
      // ruleset gap would deadlock the call.
      return await runInSandbox(args, sandbox, deps, ctx, limits)
    },
  })
}
