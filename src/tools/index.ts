import { tool } from '@opencode-ai/plugin'
import { createReviewTools } from './review'
import { createPlanTools } from './plan-kv'
import { createPlanExecuteTools } from './plan-execute'
import { createLoopTools } from './loop'
import { createAstGrepTools } from './ast-grep'
import type { ToolContext } from './types'

export { createToolExecuteBeforeHook, createToolExecuteAfterHook, createPlanApprovalEventHook } from './plan-approval'
export type { ToolContext } from './types'

/**
 * Creates all plugin tools by combining review, plan, plan-execute, and loop tools.
 *
 * @param ctx - Tool context with access to plugin services.
 * @returns Record of tool name to tool implementation.
 */
export function createTools(ctx: ToolContext): Record<string, ReturnType<typeof tool>> {
  return {
    ...createReviewTools(ctx),
    ...createPlanTools(ctx),
    ...createPlanExecuteTools(ctx),
    ...createLoopTools(ctx),
    ...createAstGrepTools(ctx),
  }
}
