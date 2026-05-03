import { createForgeExecutionService, type ForgeExecutionRequestContext } from '../../services/execution'
import type { ApiDeps } from '../types'

export function buildService(deps: ApiDeps, projectId: string) {
  const { ctx } = deps
  const execCtx: ForgeExecutionRequestContext = { surface: 'api', projectId, directory: ctx.directory }
  const service = createForgeExecutionService({
    projectId,
    directory: ctx.directory,
    config: ctx.config,
    logger: ctx.logger,
    dataDir: ctx.dataDir,
    v2: ctx.v2,
    legacyClient: ctx.input?.client,
    plansRepo: ctx.plansRepo,
    loopsRepo: ctx.loopsRepo,
    loopService: ctx.loopService,
    loopHandler: ctx.loopHandler,
    sandboxManager: ctx.sandboxManager,
  })
  return { service, execCtx }
}
