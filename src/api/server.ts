import type { ToolContext } from '../tools/types'
import { authenticate } from './auth'
import { match } from './router'
import type { Route } from './router'
import { errorResponse } from './response'
import { notFound, forbidden } from './errors'

// Import handlers
import {
  handleListProjects,
  handleGetProject,
} from './handlers/projects'
import {
  handleGetSessionPlan,
  handleGetLoopPlan,
  handleWriteSessionPlan,
  handleWriteLoopPlan,
  handlePatchSessionPlan,
  handleDeleteSessionPlan,
  handleDeleteLoopPlan,
} from './handlers/plans'
import { handleExecutePlan } from './handlers/plan-execute'
import {
  handleListLoops,
  handleGetLoop,
  handleStartLoop,
  handleCancelLoop,
  handleRestartLoop,
} from './handlers/loops'
import {
  handleListModels,
  handleGetModelPreferences,
  handleWriteModelPreferences,
} from './handlers/models'
import {
  handleListFindings,
  handleWriteFinding,
  handleDeleteFinding,
} from './handlers/findings'

export interface ForgeApiServer {
  url: string
  stop(): Promise<void>
}

function buildRoutes(): Route[] {
  const routes: Route[] = []

  // Projects
  routes.push({
    method: 'GET',
    pattern: '/api/v1/projects',
    handler: handleListProjects,
  })

  routes.push({
    method: 'GET',
    pattern: '/api/v1/projects/:projectId',
    handler: handleGetProject,
  })

  // Plans - session
  routes.push({
    method: 'GET',
    pattern: '/api/v1/projects/:projectId/plans/session/:sessionId',
    handler: handleGetSessionPlan,
  })

  routes.push({
    method: 'PUT',
    pattern: '/api/v1/projects/:projectId/plans/session/:sessionId',
    handler: handleWriteSessionPlan,
  })

  routes.push({
    method: 'PATCH',
    pattern: '/api/v1/projects/:projectId/plans/session/:sessionId',
    handler: handlePatchSessionPlan,
  })

  routes.push({
    method: 'DELETE',
    pattern: '/api/v1/projects/:projectId/plans/session/:sessionId',
    handler: handleDeleteSessionPlan,
  })

  // Plans - loop
  routes.push({
    method: 'GET',
    pattern: '/api/v1/projects/:projectId/plans/loop/:loopName',
    handler: handleGetLoopPlan,
  })

  routes.push({
    method: 'PUT',
    pattern: '/api/v1/projects/:projectId/plans/loop/:loopName',
    handler: handleWriteLoopPlan,
  })

  routes.push({
    method: 'DELETE',
    pattern: '/api/v1/projects/:projectId/plans/loop/:loopName',
    handler: handleDeleteLoopPlan,
  })

  // Plan execute
  routes.push({
    method: 'POST',
    pattern: '/api/v1/projects/:projectId/plans/session/:sessionId/execute',
    handler: handleExecutePlan,
  })

  // Loops
  routes.push({
    method: 'GET',
    pattern: '/api/v1/projects/:projectId/loops',
    handler: handleListLoops,
  })

  routes.push({
    method: 'GET',
    pattern: '/api/v1/projects/:projectId/loops/:loopName',
    handler: handleGetLoop,
  })

  routes.push({
    method: 'POST',
    pattern: '/api/v1/projects/:projectId/loops',
    handler: handleStartLoop,
  })

  routes.push({
    method: 'DELETE',
    pattern: '/api/v1/projects/:projectId/loops/:loopName',
    handler: handleCancelLoop,
  })

  routes.push({
    method: 'POST',
    pattern: '/api/v1/projects/:projectId/loops/:loopName/restart',
    handler: handleRestartLoop,
  })

  // Models
  routes.push({
    method: 'GET',
    pattern: '/api/v1/projects/:projectId/models',
    handler: handleListModels,
  })

  routes.push({
    method: 'GET',
    pattern: '/api/v1/projects/:projectId/models/preferences',
    handler: handleGetModelPreferences,
  })

  routes.push({
    method: 'PUT',
    pattern: '/api/v1/projects/:projectId/models/preferences',
    handler: handleWriteModelPreferences,
  })

  // Findings
  routes.push({
    method: 'GET',
    pattern: '/api/v1/projects/:projectId/findings',
    handler: handleListFindings,
  })

  routes.push({
    method: 'POST',
    pattern: '/api/v1/projects/:projectId/findings',
    handler: handleWriteFinding,
  })

  routes.push({
    method: 'DELETE',
    pattern: '/api/v1/projects/:projectId/findings',
    handler: handleDeleteFinding,
  })

  return routes
}

export function startForgeApiServer(ctx: ToolContext): ForgeApiServer | null {
  const apiCfg = ctx.config.api
  if (!apiCfg?.enabled) {
    return null
  }

  const host = apiCfg.host ?? '127.0.0.1'
  const port = apiCfg.port ?? 5552
  const localhostOnly = host === '127.0.0.1' || host === '::1'
  const password = process.env.OPENCODE_SERVER_PASSWORD

  if (!localhostOnly && !password) {
    ctx.logger.error(
      `[api] refusing to start: host=${host} requires OPENCODE_SERVER_PASSWORD`
    )
    return null
  }

  const routes = buildRoutes()
  const deps = {
    ctx,
    logger: ctx.logger,
    projectId: ctx.projectId,
  }

  const server = Bun.serve({
    hostname: host,
    port,
    fetch: async (req: Request) => {
      try {
        authenticate(req, { password, localhostOnly })

        const url = new URL(req.url)
        const m = match(routes, req.method, url.pathname)

        if (!m) {
          throw notFound(`no route for ${req.method} ${url.pathname}`)
        }

        // Enforce :projectId path param matches this plugin instance's projectId
        if (m.params.projectId && m.params.projectId !== ctx.projectId) {
          throw forbidden('project scope mismatch')
        }

        return await m.handler(req, deps, m.params)
      } catch (err) {
        return errorResponse(err)
      }
    },
  })

  ctx.logger.log(`[api] listening on http://${host}:${port}`)

  return {
    url: `http://${host}:${port}`,
    stop: async () => {
      server.stop(true)
    },
  }
}
