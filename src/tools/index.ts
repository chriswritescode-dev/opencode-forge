import { tool } from '@opencode-ai/plugin'
import { createReviewTools } from './review'
import { createPlanTools } from './plan-kv'
import { createLoopTools } from './loop'
import { createGroupTools } from './group'
import { createSectionReadTool } from './section-read'
import { createBashTool } from './bash/index'
import type { ToolContext } from './types'

export type { ToolContext } from './types'

/**
 * Creates all plugin tools by combining review, plan, and loop tools.
 *
 * @param ctx - Tool context with access to plugin services.
 * @returns Record of tool name to tool implementation.
 */
export function createTools(ctx: ToolContext): Record<string, ReturnType<typeof tool>> {
  const tools: Record<string, ReturnType<typeof tool>> = {
    ...createReviewTools(ctx),
    ...createPlanTools(ctx),
    ...createLoopTools(ctx),
    ...createGroupTools(ctx),
    'section-read': createSectionReadTool(ctx),
  }

  if (ctx.sandboxManager) {
    tools.sh = createBashTool({
      resolveSandboxForSession: ctx.resolveSandboxForSession,
      logger: ctx.logger,
      // Use a workspace-relative scratch dir: the worktree is mounted at
      // /workspace inside the sandbox, so .forge/tmp resolves consistently
      // for both host (read/write tools) and sandbox (bash).
      tmpDir: '.forge/tmp',
    })
  }

  return tools
}
