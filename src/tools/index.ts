import { tool } from '@opencode-ai/plugin'
import { createReviewTools } from './review'
import { createPlanTools } from './plan-kv'
import { createPlanExecuteTools } from './plan-execute'
import { createLoopTools } from './loop'
import { createGraphTools } from './graph'
import type { ToolContext } from './types'

export { createToolExecuteBeforeHook, createToolExecuteAfterHook, createPlanApprovalEventHook } from './plan-approval'
export type { ToolContext } from './types'

/**
 * Creates all plugin tools by combining review, plan, plan-execute, loop, and (when enabled) graph tools.
 *
 * Graph tools are only registered when `ctx.graphService` is non-null. When the graph feature is
 * disabled in config, the service is null and graph tools are omitted entirely so agents do not
 * see them in the tool list.
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
    ...(ctx.graphService ? createGraphTools(ctx) : {}),
  }
}
