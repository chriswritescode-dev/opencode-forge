
import { createReviewTools } from './review'
import { createPlanTools } from './plan-kv'
import { createPlanAuthoringTools } from './plan-authoring'
import { createLoopTools } from './loop'
import { createLoopHandoffTools } from './loop-handoff'
import { createSectionReadTool } from './section-read'
import { createPlanAdjustTool } from './plan-adjust'
import type { ToolContext } from './types'

export type { ToolContext } from './types'

export function createTools(ctx: ToolContext) {
  return {
    ...createReviewTools(ctx),
    ...createPlanTools(ctx),
    ...createPlanAuthoringTools(ctx),
    ...createLoopTools(ctx),
    ...createLoopHandoffTools(ctx),
    'section-read': createSectionReadTool(ctx),
    'plan-adjust': createPlanAdjustTool(ctx),
  }
}
