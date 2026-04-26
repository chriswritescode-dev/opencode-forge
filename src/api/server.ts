import type { ToolContext } from '../tools/types'
import { authenticate } from './auth'
import { match } from './router'
import type { Route } from './router'
import { errorResponse } from './response'
import { notFound } from './errors'
import type { ApiDeps } from './types'
import type { ProjectRegistry } from './project-registry'

// Import handlers
import {
  handleListProjects,
  handleGetProject,
  handleGetGraphStatus,
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

type SharedServer = {
  url: string
  host: string
  port: number
  refCount: number
  bunServer: ReturnType<typeof Bun.serve>
}

let sharedServer: SharedServer | null = null

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

  routes.push({
    method: 'GET',
    pattern: '/api/v1/projects/:projectId/graph/status',
    handler: handleGetGraphStatus,
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

function buildFetchHandler(
  routes: Route[],
  registry: ProjectRegistry,
  password: string | undefined,
  localhostOnly: boolean
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    try {
      authenticate(req, { password, localhostOnly })

      const url = new URL(req.url)
      const m = match(routes, req.method, url.pathname)
      const requestDirectory = url.searchParams.get('directory') ?? req.headers.get('x-opencode-directory') ?? undefined

      if (!m) {
        throw notFound(`no route for ${req.method} ${url.pathname}`)
      }

      let ctx: ToolContext | null = null
      if (m.params.projectId) {
        ctx = requestDirectory ? registry.findByDirectory(requestDirectory) : registry.get(m.params.projectId)
        if (!ctx) {
          throw notFound(`project not registered: ${m.params.projectId}`)
        }
        if (ctx.projectId !== m.params.projectId) {
          throw notFound(`project not registered: ${m.params.projectId}`)
        }
      } else {
        const directoryCtx = requestDirectory ? registry.findByDirectory(requestDirectory) : null
        const all = registry.list()
        if (all.length === 0) {
          throw notFound('no projects registered')
        }
        ctx = directoryCtx ?? all[0]
      }

      const deps: ApiDeps = {
        ctx,
        logger: ctx.logger,
        projectId: ctx.projectId,
        registry,
      }

      return await m.handler(req, deps, m.params)
    } catch (err) {
      return errorResponse(err)
    }
  }
}

export function attachForgeApiServer(
  ctx: ToolContext,
  registry: ProjectRegistry
): ForgeApiServer | null {
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

  if (!sharedServer) {
    try {
      const routes = buildRoutes()
      const bunServer = Bun.serve({
        hostname: host,
        port,
        fetch: buildFetchHandler(routes, registry, password, localhostOnly),
      })
      sharedServer = {
        url: `http://${host}:${port}`,
        host,
        port,
        refCount: 1,
        bunServer,
      }
      ctx.logger.log(`[api] listening on http://${host}:${port}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      ctx.logger.error(`[api] failed to bind ${host}:${port}: ${message}`)
      return null
    }
  } else if (sharedServer.host !== host || sharedServer.port !== port) {
    ctx.logger.error(
      `[api] cannot start with ${host}:${port}: existing listener on ${sharedServer.host}:${sharedServer.port}`
    )
    return null
  } else {
    sharedServer.refCount += 1
    ctx.logger.log(
      `[api] reusing listener for project ${ctx.projectId} (refCount=${sharedServer.refCount})`
    )
  }

  let released = false

  return {
    url: sharedServer.url,
    stop: async () => {
      if (released) {
        return
      }
      released = true

      if (!sharedServer) {
        return
      }

      sharedServer.refCount -= 1

      if (sharedServer.refCount <= 0) {
        sharedServer.bunServer.stop(true)
        sharedServer = null
        ctx.logger.log('[api] stopped')
        return
      }

      ctx.logger.log(
        `[api] released listener for project ${ctx.projectId} (refCount=${sharedServer.refCount})`
      )
    },
  }
}
