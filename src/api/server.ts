import type { ToolContext } from '../tools/types'
import { authenticate } from './auth'
import { match } from './router'
import type { Route } from './router'
import { errorResponse } from './response'
import { notFound } from './errors'
import type { ApiDeps } from './types'
import type { ProjectRegistry } from './project-registry'
import { createApiRegistryRepo } from '../storage'
import { handleRegisterProjectInstance } from './handlers/internal'
import { buildOpencodeBasicAuthHeader } from '../utils/opencode-client'

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

export type ForgeApiRole = 'coordinator' | 'attached'

export interface ForgeApiServer {
  url: string
  role: ForgeApiRole
  stop(): Promise<void>
}

const API_LEASE_TTL_MS = 30_000
const API_HEARTBEAT_MS = 5_000
const API_COORDINATOR_REQUEST_TIMEOUT_MS = 5_000

type OwnerServer = {
  url: string
  stop(): void
}

type AttachmentState = {
  instanceId: string
  ownerServer: OwnerServer
  publicKey: string
  heartbeatTimer: ReturnType<typeof setInterval> | null
  released: boolean
}

type PublicAttachment = {
  instanceId: string
  fetchHandler: (req: Request) => Promise<Response>
  apiRegistryRepo: ReturnType<typeof createApiRegistryRepo>
  ctx: ToolContext
  setRole(role: ForgeApiRole): void
}

type PublicServerSlot = {
  server: ReturnType<typeof Bun.serve>
  coordinatorInstanceId: string
  currentFetchHandler: (req: Request) => Promise<Response>
  attachments: Map<string, PublicAttachment>
}

const PUBLIC_SERVER_SLOTS_KEY = Symbol.for('forge.api.public-server-slots')

function getPublicServerSlots(): Map<string, PublicServerSlot> {
  const globalState = globalThis as typeof globalThis & {
    [PUBLIC_SERVER_SLOTS_KEY]?: Map<string, PublicServerSlot>
  }
  if (!globalState[PUBLIC_SERVER_SLOTS_KEY]) {
    globalState[PUBLIC_SERVER_SLOTS_KEY] = new Map()
  }
  return globalState[PUBLIC_SERVER_SLOTS_KEY]
}

function publicServerKey(host: string, port: number): string {
  return `${host}:${port}`
}

function withTimeoutSignal(timeoutMs: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs)
  }
  const controller = new AbortController()
  setTimeout(() => controller.abort(), timeoutMs)
  return controller.signal
}

function createApiInstanceId(ctx: ToolContext): string {
  const randomPart = Math.random().toString(36).slice(2)
  return `${ctx.projectId}:${process.pid}:${Date.now()}:${randomPart}`
}

function isAddressInUse(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code
    if (code === 'EADDRINUSE') {
      return true
    }

    const message = err.message.toLowerCase()
    return (
      message.includes('eaddrinuse') ||
      message.includes('address already in use') ||
      /\bport\b.*\bin use\b/.test(message)
    )
  }
  return false
}

function startOwnerServer(ctx: ToolContext, registry: ProjectRegistry): OwnerServer {
  const routes = buildRoutes()
  const apiRegistryRepo = createApiRegistryRepo(ctx.db)
  const password = process.env.OPENCODE_SERVER_PASSWORD
  const localhostOnly = true
  
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: buildFetchHandler(routes, registry, password, localhostOnly, apiRegistryRepo),
  })
  
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  }
}

function registerInstance(
  repo: ReturnType<typeof createApiRegistryRepo>,
  ctx: ToolContext,
  instanceId: string,
  ownerUrl: string,
  now: number
): void {
  repo.upsertProjectInstance({
    instanceId,
    projectId: ctx.projectId,
    directory: ctx.directory,
    ownerUrl,
    pid: process.pid,
    now,
    ttlMs: API_LEASE_TTL_MS,
  })
}

function startHeartbeat(
  repo: ReturnType<typeof createApiRegistryRepo>,
  instanceId: string,
  getRole: () => ForgeApiRole,
  onTick?: (now: number) => void
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    try {
      const now = Date.now()
      const role = getRole()
      repo.touchProjectInstance(instanceId, now, API_LEASE_TTL_MS)
      if (role === 'coordinator') {
        repo.touchCoordinator(instanceId, now, API_LEASE_TTL_MS)
      }
      repo.pruneExpired(now)
      onTick?.(now)
    } catch (err) {
      console.error('[api] heartbeat failed:', err)
    }
  }, API_HEARTBEAT_MS)
}

async function tryRegisterWithCoordinator(
  publicUrl: string,
  ctx: ToolContext,
  ownerUrl: string,
  instanceId: string
): Promise<boolean> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    
    const password = process.env.OPENCODE_SERVER_PASSWORD
    if (password) {
      headers.Authorization = buildOpencodeBasicAuthHeader(password)
    }
    
    const response = await fetch(`${publicUrl}/api/v1/internal/register`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        projectId: ctx.projectId,
        directory: ctx.directory,
        ownerUrl,
        pid: process.pid,
        instanceId,
      }),
      signal: withTimeoutSignal(API_COORDINATOR_REQUEST_TIMEOUT_MS),
    })
    
    return response.ok
  } catch (err) {
    console.error('[api] coordinator registration request failed:', err)
    return false
  }
}

async function canReachCoordinator(publicUrl: string, password: string | undefined): Promise<boolean> {
  try {
    const headers: Record<string, string> = {}
    if (password) {
      headers['Authorization'] = `Bearer ${password}`
    }

    const response = await fetch(`${publicUrl}/api/v1/projects`, {
      method: 'GET',
      headers,
      signal: withTimeoutSignal(API_COORDINATOR_REQUEST_TIMEOUT_MS),
    })
    return response.status < 500
  } catch {
    return false
  }
}

function proxyToOwner(req: Request, ownerUrl: string): Promise<Response> {
  const source = new URL(req.url)
  const target = new URL(source.pathname + source.search, ownerUrl)
  
  const headers = new Headers()
  for (const [key, value] of req.headers.entries()) {
    if (!['host', 'origin', 'referer'].includes(key.toLowerCase())) {
      headers.set(key, value)
    }
  }
  
  const method = req.method
  const body = (method === 'GET' || method === 'HEAD') ? undefined : req.body
  
  return fetch(target, {
    method,
    headers,
    body,
  })
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

  // Internal registration
  routes.push({
    method: 'POST',
    pattern: '/api/v1/internal/register',
    handler: handleRegisterProjectInstance,
  })

  return routes
}

function buildFetchHandler(
  routes: Route[],
  registry: ProjectRegistry,
  password: string | undefined,
  localhostOnly: boolean,
  apiRegistryRepo: ReturnType<typeof createApiRegistryRepo>
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

      // Handle internal registration route specially - it doesn't need ctx
      if (m.params.projectId === 'internal' && url.pathname === '/api/v1/internal/register') {
        const firstCtx = registry.list()[0]
        const deps: ApiDeps = {
          ctx: firstCtx ?? ({} as ToolContext),
          logger: firstCtx?.logger ?? console,
          projectId: 'internal',
          registry,
          apiRegistryRepo,
        }
        return await m.handler(req, deps, m.params)
      }

      let ctx: ToolContext | null = null
      if (m.params.projectId) {
        ctx = requestDirectory ? registry.findByDirectory(requestDirectory) : registry.get(m.params.projectId)
        if (!ctx) {
          ctx = requestDirectory ? registry.findByDirectory(requestDirectory) : null
        }
        if (ctx && ctx.projectId !== m.params.projectId) {
          ctx = null
        }
      } else {
        const directoryCtx = requestDirectory ? registry.findByDirectory(requestDirectory) : null
        const all = registry.list()
        if (all.length === 0) {
          throw notFound('no projects registered')
        }
        ctx = directoryCtx ?? all[0]
      }

      // If no local ctx, check persisted registry for owner
      if (!ctx && m.params.projectId) {
        const owner = apiRegistryRepo.getProjectInstanceByProject(m.params.projectId)
        if (owner && owner.expiresAt > Date.now()) {
          return await proxyToOwner(req, owner.ownerUrl)
        }
      }

      if (!ctx) {
        throw notFound(`project not registered: ${m.params.projectId}`)
      }

      const deps: ApiDeps = {
        ctx,
        logger: ctx.logger,
        projectId: ctx.projectId,
        registry,
        apiRegistryRepo,
      }

      return await m.handler(req, deps, m.params)
    } catch (err) {
      return errorResponse(err)
    }
  }
}

export async function attachForgeApiServer(
  ctx: ToolContext,
  registry: ProjectRegistry
): Promise<ForgeApiServer | null> {
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

  const apiRegistryRepo = createApiRegistryRepo(ctx.db)
  const instanceId = createApiInstanceId(ctx)
  const now = Date.now()
  const publicKey = publicServerKey(host, port)
  const publicUrl = `http://${host}:${port}`

  // Start owner server first
  const ownerServer = startOwnerServer(ctx, registry)

  // Register this process in persisted registry
  registerInstance(apiRegistryRepo, ctx, instanceId, ownerServer.url, now)

  const routes = buildRoutes()
  const fetchHandler = buildFetchHandler(routes, registry, password, localhostOnly, apiRegistryRepo)
  const slots = getPublicServerSlots()

  let role: ForgeApiRole = 'attached'

  const attachment: PublicAttachment = {
    instanceId,
    fetchHandler,
    apiRegistryRepo,
    ctx,
    setRole(nextRole) {
      role = nextRole
    },
  }

  const attachToLocalSlot = (slot: PublicServerSlot, nextRole: ForgeApiRole): ForgeApiRole => {
    slot.attachments.set(instanceId, attachment)
    attachment.setRole(nextRole)
    return role
  }

  const promoteToCoordinator = (logSuccess: boolean): 'promoted' | 'address-in-use' | 'failed' => {
    const existing = slots.get(publicKey)
    if (existing) {
      attachToLocalSlot(existing, existing.coordinatorInstanceId === instanceId ? 'coordinator' : 'attached')
      return 'promoted'
    }

    let slot: PublicServerSlot
    try {
      const server = Bun.serve({
        hostname: host,
        port,
        fetch: (req) => slot.currentFetchHandler(req),
      })
      slot = {
        server,
        coordinatorInstanceId: instanceId,
        currentFetchHandler: fetchHandler,
        attachments: new Map([[instanceId, attachment]]),
      }
      slots.set(publicKey, slot)
    } catch (err) {
      if (isAddressInUse(err)) {
        return 'address-in-use'
      } else {
        const message = err instanceof Error ? err.message : String(err)
        ctx.logger.error(`[api] failed to bind ${host}:${port}: ${message}`)
        return 'failed'
      }
    }

    apiRegistryRepo.upsertCoordinator({
      host,
      port,
      url: publicUrl,
      instanceId,
      pid: process.pid,
      now: Date.now(),
      ttlMs: API_LEASE_TTL_MS,
    })
    role = 'coordinator'
    if (logSuccess) {
      ctx.logger.log(`[api] listening on ${publicUrl}`)
    }
    return 'promoted'
  }

  const localSlot = slots.get(publicKey)
  if (localSlot) {
    attachToLocalSlot(localSlot, 'attached')
    ctx.logger.log(`[api] attached to local listener ${publicUrl}`)
  } else {
    const coordinator = apiRegistryRepo.getCoordinator(host, port)
    const reachable = !!coordinator && coordinator.expiresAt > Date.now() && await canReachCoordinator(publicUrl, password)
    if (reachable) {
      role = 'attached'
      const registered = await tryRegisterWithCoordinator(publicUrl, ctx, ownerServer.url, instanceId)
      if (!registered) {
        ctx.logger.log('[api] attached via persisted registry; coordinator registration request failed')
      }
      ctx.logger.log(`[api] attached to existing listener ${publicUrl}`)
    } else {
      const promotionResult = promoteToCoordinator(true)
      if (promotionResult === 'failed') {
        ownerServer.stop()
        apiRegistryRepo.deleteProjectInstance(instanceId)
        return null
      }
      if (promotionResult === 'address-in-use') {
        role = 'attached'
        const registered = await tryRegisterWithCoordinator(publicUrl, ctx, ownerServer.url, instanceId)
        if (!registered) {
          ctx.logger.log('[api] attached via persisted registry; coordinator registration request failed')
        }
        ctx.logger.log(`[api] attached to existing listener ${publicUrl}`)
      }
    }
  }

  const transferCoordinator = (slot: PublicServerSlot): void => {
    const next = slot.attachments.values().next().value as PublicAttachment | undefined
    if (!next) return
    slot.coordinatorInstanceId = next.instanceId
    slot.currentFetchHandler = next.fetchHandler
    next.setRole('coordinator')
    next.apiRegistryRepo.upsertCoordinator({
      host,
      port,
      url: publicUrl,
      instanceId: next.instanceId,
      pid: process.pid,
      now: Date.now(),
      ttlMs: API_LEASE_TTL_MS,
    })
    next.ctx.logger.log(`[api] coordinator transferred to project ${next.ctx.projectId}`)
  }

  let takeoverInFlight = false

  const tryTakeover = async (): Promise<void> => {
    if (role === 'coordinator' || state.released || takeoverInFlight) return
    const slot = slots.get(publicKey)
    if (slot) {
      attachToLocalSlot(slot, 'attached')
      return
    }
    takeoverInFlight = true
    try {
      if (await canReachCoordinator(publicUrl, password)) return
      if (promoteToCoordinator(false) === 'promoted') {
        ctx.logger.log(`[api] took over listener ${publicUrl}`)
      }
    } finally {
      takeoverInFlight = false
    }
  }

  // Start heartbeat
  const heartbeatTimer = startHeartbeat(apiRegistryRepo, instanceId, () => role, () => {
    void tryTakeover()
  })

  const state: AttachmentState = {
    instanceId,
    ownerServer,
    publicKey,
    heartbeatTimer,
    released: false,
  }

  return {
    url: publicUrl,
    role,
    stop: async () => {
      if (state.released) {
        return
      }
      state.released = true

      if (state.heartbeatTimer) {
        clearInterval(state.heartbeatTimer)
      }

      apiRegistryRepo.deleteProjectInstance(state.instanceId)

      const slot = slots.get(state.publicKey)
      if (slot) {
        slot.attachments.delete(state.instanceId)

        if (slot.coordinatorInstanceId === state.instanceId) {
          apiRegistryRepo.deleteCoordinator(state.instanceId)
          if (slot.attachments.size > 0) {
            transferCoordinator(slot)
          } else {
            slot.server.stop(true)
            slots.delete(state.publicKey)
            ctx.logger.log('[api] stopped')
          }
        } else {
          ctx.logger.log(`[api] detached from listener for project ${ctx.projectId}`)
        }
      } else if (role === 'coordinator') {
        apiRegistryRepo.deleteCoordinator(state.instanceId)
        ctx.logger.log('[api] stopped')
      } else {
        ctx.logger.log(`[api] detached from listener for project ${ctx.projectId}`)
      }

      state.ownerServer.stop()
    },
  }
}
