
import { createReviewTools } from './review'
import { createPlanTools } from './plan-kv'
import { createPlanAuthoringTools } from './plan-authoring'
import { createLoopTools } from './loop'
import { createLoopHandoffTools } from './loop-handoff'
import { createSectionReadTool } from './section-read'
import { createPlanAdjustTool } from './plan-adjust'
import type { ToolContext } from './types'
import type { ToolDefinition } from './tool'

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

function manifestAccess(): never {
  throw new Error('Forge tool manifest context is not executable')
}

function createManifestContext(): ToolContext {
  return {
    get projectId(): never { return manifestAccess() },
    get directory(): never { return manifestAccess() },
    get config(): never { return manifestAccess() },
    get logger(): never { return manifestAccess() },
    get db(): never { return manifestAccess() },
    get dataDir(): never { return manifestAccess() },
    get loopHandler(): never { return manifestAccess() },
    get loop(): never { return manifestAccess() },
    get client(): never { return manifestAccess() },
    get cleanup(): never { return manifestAccess() },
    get sandboxManager(): never { return manifestAccess() },
    get plansRepo(): never { return manifestAccess() },
    get reviewFindingsRepo(): never { return manifestAccess() },
    get loopsRepo(): never { return manifestAccess() },
    get sectionPlansRepo(): never { return manifestAccess() },
    get loopSessionUsageRepo(): never { return manifestAccess() },
    get pendingTeardowns(): never { return manifestAccess() },
    get resolveActiveLoopForSession(): never { return manifestAccess() },
  }
}

export function createToolManifest(): Record<string, ToolDefinition> {
  return createTools(createManifestContext())
}
