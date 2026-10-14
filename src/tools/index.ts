import type { ToolDefinition } from './tool'
import { createReviewTools } from './review'
import { createPlanTools } from './plan-kv'
import { createPlanAuthoringTools } from './plan-authoring'
import { createGoalTools } from './goal'
import { createLoopTools } from './loop'
import { createSectionReadTool } from './section-read'
import { createPlanAdjustTool } from './plan-adjust'
import type { ToolContext } from './types'

export type { ToolContext } from './types'

/**
 * Creates all plugin tools by combining review, plan, and loop tools.
 *
 * @param ctx - Tool context with access to plugin services.
 * @returns Record of tool name to tool implementation.
 */
export function createTools(ctx: ToolContext): Record<string, ToolDefinition> {
  return {
    ...createReviewTools(ctx),
    ...createPlanTools(ctx),
    ...createPlanAuthoringTools(ctx),
    ...createGoalTools(ctx),
    ...createLoopTools(ctx),
    'section-read': createSectionReadTool(ctx),
    'plan-adjust': createPlanAdjustTool(ctx),
  }
}
