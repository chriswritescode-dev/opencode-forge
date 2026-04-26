import type { PluginConfig } from '../types'
import { buildOpencodeBasicAuthHeader, sanitizeServerUrl } from './opencode-client'
import type { LoopInfo } from './tui-refresh-helpers'
import type { GraphStatusPayload } from './graph-status-store'
import type { ExecutionPreferences } from './tui-execution-preferences'
import { execFileSync } from 'node:child_process'
import { platform } from 'node:os'

type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

export type ApiExecutionMode = 'new-session' | 'execute-here' | 'loop' | 'loop-worktree'

export interface ExecutionContext {
  preferences: ExecutionPreferences | null
  models: {
    providers: unknown[]
    connectedProviderIds?: string[]
    configuredProviderIds?: string[]
    error?: string
  }
}

export interface ExecutePlanRequest {
  mode: ApiExecutionMode
  title: string
  plan: string
  executionModel?: string
  auditorModel?: string
  targetSessionId?: string
}

export interface StartLoopRequest {
  plan: string
  title: string
  worktree: boolean
  executionModel?: string
  auditorModel?: string
  hostSessionId?: string
}

export interface ForgeProjectClient {
  readonly projectId: string

  plan: {
    read(sessionId: string): Promise<string | null>
    write(sessionId: string, content: string): Promise<boolean>
    delete(sessionId: string): Promise<boolean>
    /**
     * Execute workflow:
     *   1) POST /plans/session/:id/execute
     *   2) on success, PUT /models/preferences (best-effort)
     *   3) plans persist in session-scoped repo for retry capability
     * Returns the execute result; preference failures are swallowed.
     */
    execute(
      sessionId: string,
      req: ExecutePlanRequest,
      prefs: ExecutionPreferences,
    ): Promise<{ sessionId?: string; loopName?: string; worktreeDir?: string } | null>
  }

  loops: {
    list(): Promise<LoopInfo[]>
    get(loopName: string): Promise<LoopInfo | null>
    cancel(loopName: string): Promise<boolean>
    restart(loopName: string, force: boolean): Promise<string | null>
    start(req: StartLoopRequest): Promise<{ sessionId: string; loopName: string; worktreeDir?: string } | null>
  }

  /** Single round-trip pair: read preferences and list models. */
  loadExecutionContext(): Promise<ExecutionContext>

  readGraphStatus(cwd: string): Promise<GraphStatusPayload | null>
}

function makeRemoteRequest(baseUrl: string, password?: string, directory?: string) {
  const root = baseUrl.replace(/\/$/, '')
  const headers: Record<string, string> = {
    Accept: 'application/json',
  }
  if (password) {
    headers.Authorization = buildOpencodeBasicAuthHeader(password)
  }
  if (directory) {
    headers['x-opencode-directory'] = directory
  }

  return async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${root}${path}`, {
      ...init,
      headers: {
        ...headers,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    })
    const envelope = await res.json() as ApiEnvelope<T>
    if (!res.ok || !envelope.ok) {
      const message = envelope.ok ? `request failed: ${res.status}` : envelope.error.message
      throw new Error(message)
    }
    return envelope.data
  }
}

function readOpencodeServerPasswordFromKeychain(): string | undefined {
  if (platform() !== 'darwin') return undefined
  try {
    return execFileSync('security', ['find-generic-password', '-a', 'opencode', '-s', 'opencode-server-password', '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).trim() || undefined
  } catch {
    return undefined
  }
}

function resolveForgeApiPassword(urlPassword?: string): string | undefined {
  return urlPassword || process.env['OPENCODE_SERVER_PASSWORD'] || readOpencodeServerPasswordFromKeychain()
}

function mapRemoteLoop(input: Record<string, unknown>): LoopInfo {
  return {
    name: String(input.loopName ?? input.name ?? ''),
    phase: String(input.phase ?? input.status ?? ''),
    iteration: Number(input.iteration ?? 0),
    maxIterations: Number(input.maxIterations ?? 0),
    sessionId: String(input.sessionId ?? ''),
    active: Boolean(input.active ?? input.status === 'running'),
    startedAt: input.startedAt as string | undefined,
    completedAt: input.completedAt as string | undefined,
    terminationReason: input.terminationReason as string | undefined,
    worktreeBranch: input.worktreeBranch as string | undefined,
    worktree: input.worktree as boolean | undefined,
    worktreeDir: input.worktreeDir as string | undefined,
    executionModel: input.executionModel as string | undefined,
    auditorModel: input.auditorModel as string | undefined,
    workspaceId: input.workspaceId as string | undefined,
    hostSessionId: input.hostSessionId as string | undefined,
  }
}

function mapPrefMode(label: ExecutionPreferences['mode']): ApiExecutionMode {
  return label === 'Execute here' ? 'execute-here'
    : label === 'Loop' ? 'loop'
    : label === 'Loop (worktree)' ? 'loop-worktree'
    : 'new-session'
}

export function resolveForgeApiUrl(config: PluginConfig): string {
  const remoteUrl = config.tui?.remoteServer?.url?.trim()
  if (remoteUrl) return remoteUrl
  const host = config.api?.host ?? '127.0.0.1'
  const port = config.api?.port ?? 5552
  const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `http://${formattedHost}:${port}`
}

function buildClient(
  projectId: string,
  request: <T>(path: string, init?: RequestInit) => Promise<T>,
): ForgeProjectClient {
  const projectPath = `/api/v1/projects/${encodeURIComponent(projectId)}`

  const plan: ForgeProjectClient['plan'] = {
    async read(sessionId) {
      try {
        const data = await request<{ content: string }>(`${projectPath}/plans/session/${encodeURIComponent(sessionId)}`)
        return data.content
      } catch { return null }
    },
    async write(sessionId, content) {
      try {
        await request(`${projectPath}/plans/session/${encodeURIComponent(sessionId)}`, {
          method: 'PUT',
          body: JSON.stringify({ content }),
        })
        return true
      } catch { return false }
    },
    async delete(sessionId) {
      try {
        await request(`${projectPath}/plans/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
        return true
      } catch { return false }
    },
    async execute(sessionId, req, prefs) {
      let result: { sessionId?: string; loopName?: string; worktreeDir?: string } | null
      try {
        result = await request(`${projectPath}/plans/session/${encodeURIComponent(sessionId)}/execute`, {
          method: 'POST',
          body: JSON.stringify(req),
        })
      } catch { return null }

      // Best-effort prefs save
      try {
        const mode = mapPrefMode(prefs.mode)
        await request(`${projectPath}/models/preferences`, {
          method: 'PUT',
          body: JSON.stringify({ mode, executionModel: prefs.executionModel, auditorModel: prefs.auditorModel }),
        })
      } catch { /* ignore */ }

      return result
    },
  }

  const loops: ForgeProjectClient['loops'] = {
    async list() {
      try {
        const data = await request<{ loops?: unknown[]; active?: unknown[]; recent?: unknown[] }>(`${projectPath}/loops`)
        const arr = data.loops ?? [...(data.active ?? []), ...(data.recent ?? [])]
        return arr.map((l) => mapRemoteLoop(l as Record<string, unknown>))
      } catch { return [] }
    },
    async get(loopName) {
      try {
        const data = await request<Record<string, unknown>>(`${projectPath}/loops/${encodeURIComponent(loopName)}`)
        return mapRemoteLoop(data)
      } catch { return null }
    },
    async cancel(loopName) {
      try {
        await request(`${projectPath}/loops/${encodeURIComponent(loopName)}`, { method: 'DELETE' })
        return true
      } catch { return false }
    },
    async restart(loopName, force) {
      try {
        const data = await request<{ sessionId?: string }>(`${projectPath}/loops/${encodeURIComponent(loopName)}/restart`, {
          method: 'POST',
          body: JSON.stringify({ force }),
        })
        return data.sessionId ?? null
      } catch { return null }
    },
    async start(req) {
      try {
        return await request(`${projectPath}/loops`, {
          method: 'POST',
          body: JSON.stringify(req),
        })
      } catch { return null }
    },
  }

  return {
    projectId,
    plan,
    loops,
    async loadExecutionContext() {
      const [prefsResult, modelsResult] = await Promise.all([
        request<ExecutionPreferences>(`${projectPath}/models/preferences`).catch(() => null),
        request<ExecutionContext['models']>(`${projectPath}/models`).catch(() => ({ providers: [], error: 'Failed to load models' })),
      ])
      return { preferences: prefsResult, models: modelsResult }
    },
    async readGraphStatus(cwd) {
      try {
        const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
        const data = await request<{ status: GraphStatusPayload | null }>(`${projectPath}/graph/status${query}`)
        return data.status
      } catch { return null }
    },
  }
}

const DIRECTORY_RESOLUTION_ATTEMPTS = 5
const DIRECTORY_RESOLUTION_RETRY_MS = 100

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function resolveProjectId(
  request: <T>(path: string, init?: RequestInit) => Promise<T>,
  directory?: string,
): Promise<string | null> {
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : ''
  const data = await request<{ projects: Array<{ id: string; directory?: string | null }> }>(`/api/v1/projects${query}`)

  if (!directory) {
    return data.projects[0]?.id ?? null
  }

  return data.projects.find((project) => project.directory === directory)?.id ?? null
}

async function resolveProjectIdWithRetry(
  request: <T>(path: string, init?: RequestInit) => Promise<T>,
  directory?: string,
): Promise<string | null> {
  if (!directory) return resolveProjectId(request)

  for (let attempt = 0; attempt < DIRECTORY_RESOLUTION_ATTEMPTS; attempt += 1) {
    const id = await resolveProjectId(request, directory)
    if (id) return id
    if (attempt < DIRECTORY_RESOLUTION_ATTEMPTS - 1) {
      await sleep(DIRECTORY_RESOLUTION_RETRY_MS)
    }
  }

  return null
}

export async function connectForgeProject(
  config: PluginConfig,
  directory?: string
): Promise<ForgeProjectClient | null> {
  const rawUrl = resolveForgeApiUrl(config)

  let baseUrl: string
  let urlPassword: string | undefined
  try {
    const sanitized = sanitizeServerUrl(rawUrl)
    baseUrl = sanitized.baseUrl
    urlPassword = sanitized.password
  } catch {
    return null
  }

  const password = resolveForgeApiPassword(urlPassword)
  const request = makeRemoteRequest(baseUrl, password, directory)

  let projectId: string
  try {
    const id = await resolveProjectIdWithRetry(request, directory)
    if (!id) return null
    projectId = id
  } catch {
    return null
  }

  return buildClient(projectId, request)
}
