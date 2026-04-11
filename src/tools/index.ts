import { tool } from '@opencode-ai/plugin'
import { createReviewTools } from './review'
import { createPlanTools } from './plan-kv'
import { createPlanExecuteTools } from './plan-execute'
import { createLoopTools } from './loop'
import { createGraphTools } from './graph'
import type { ToolContext } from './types'

export { createToolExecuteBeforeHook, createToolExecuteAfterHook, createPlanApprovalEventHook } from './plan-approval'
export type { ToolContext } from './types'

export function createTools(ctx: ToolContext): Record<string, ReturnType<typeof tool>> {
  return {
    ...createReviewTools(ctx),
    ...createPlanTools(ctx),
    ...createPlanExecuteTools(ctx),
    ...createLoopTools(ctx),
    ...createGraphTools(ctx),
  }
}
