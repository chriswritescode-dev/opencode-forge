import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import type { TuiConfig } from '../types'
import { buildOpencodeBasicAuthHeader, createOpencodeClientFromServer, sanitizeServerUrl } from './opencode-client'
import type { LoopInfo } from './tui-refresh-helpers'
import type { GraphStatusPayload } from './graph-status-store'
import type { ExecutionPreferences } from './tui-execution-preferences'

export function resolveTuiClient(api: TuiPluginApi, tuiConfig: TuiConfig | undefined): TuiPluginApi['client'] {
  const url = tuiConfig?.remoteServer?.url?.trim()
  if (!url) return api.client
  try {
    return createOpencodeClientFromServer({
      serverUrl: url,
      directory: api.state.path.directory,
    }) as TuiPluginApi['client']
  } catch {
    api.ui.toast({
      message: 'Invalid remote OpenCode server URL; using local client',
      variant: 'warning',
      duration: 5000,
    })
    return api.client
  }
}

type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

export type ApiExecutionMode = 'new-session' | 'execute-here' | 'loop' | 'loop-worktree'

export interface RemoteTuiStateClient {
  getProjectId(): Promise<string | null>
  readPlan(projectId: string, sessionId: string): Promise<string | null>
  writePlan(projectId: string, sessionId: string, content: string): Promise<boolean>
  deletePlan(projectId: string, sessionId: string): Promise<boolean>
  listLoops(projectId: string): Promise<LoopInfo[]>
  getLoop(projectId: string, loopName: string): Promise<LoopInfo | null>
  cancelLoop(projectId: string, loopName: string): Promise<boolean>
  restartLoop(projectId: string, loopName: string, force: boolean): Promise<string | null>
  readGraphStatus(projectId: string, cwd: string): Promise<GraphStatusPayload | null>
  readPreferences(projectId: string): Promise<ExecutionPreferences | null>
  writePreferences(projectId: string, prefs: ExecutionPreferences): Promise<boolean>
  listModels(projectId: string): Promise<{
    providers: unknown[]
    connectedProviderIds?: string[]
    configuredProviderIds?: string[]
    error?: string
  }>
  executePlan(projectId: string, sessionId: string, body: {
    mode: ApiExecutionMode
    title: string
    plan: string
    executionModel?: string
    auditorModel?: string
    targetSessionId?: string
  }): Promise<{ sessionId?: string; loopName?: string; worktreeDir?: string } | null>
  startLoop(projectId: string, body: {
    plan: string
    title: string
    worktree: boolean
    executionModel?: string
    auditorModel?: string
    hostSessionId?: string
  }): Promise<{ sessionId: string; loopName: string; worktreeDir?: string } | null>
}

function makeRemoteRequest(baseUrl: string, password?: string) {
  const root = baseUrl.replace(/\/$/, '')
  const headers: Record<string, string> = {
    Accept: 'application/json',
  }
  if (password) {
    headers.Authorization = buildOpencodeBasicAuthHeader(password)
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

export function resolveRemoteTuiStateClient(tuiConfig: TuiConfig | undefined): RemoteTuiStateClient | null {
  const rawUrl = tuiConfig?.remoteServer?.url?.trim()
  if (!rawUrl) return null

  let baseUrl: string
  let urlPassword: string | undefined
  try {
    const sanitized = sanitizeServerUrl(rawUrl)
    baseUrl = sanitized.baseUrl
    urlPassword = sanitized.password
  } catch {
    return null
  }
  const password = urlPassword || process.env['OPENCODE_SERVER_PASSWORD']
  const request = makeRemoteRequest(baseUrl, password)

  return {
    async getProjectId() {
      try {
        const data = await request<{ projects: Array<{ id: string }> }>('/api/v1/projects')
        return data.projects[0]?.id ?? null
      } catch {
        return null
      }
    },
    async readPlan(projectId, sessionId) {
      try {
        const data = await request<{ content: string }>(`/api/v1/projects/${encodeURIComponent(projectId)}/plans/session/${encodeURIComponent(sessionId)}`)
        return data.content
      } catch {
        return null
      }
    },
    async writePlan(projectId, sessionId, content) {
      try {
        await request(`/api/v1/projects/${encodeURIComponent(projectId)}/plans/session/${encodeURIComponent(sessionId)}`, {
          method: 'PUT',
          body: JSON.stringify({ content }),
        })
        return true
      } catch {
        return false
      }
    },
    async deletePlan(projectId, sessionId) {
      try {
        await request(`/api/v1/projects/${encodeURIComponent(projectId)}/plans/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
        return true
      } catch {
        return false
      }
    },
    async listLoops(projectId) {
      const data = await request<{ loops?: unknown[]; active?: unknown[]; recent?: unknown[] }>(`/api/v1/projects/${encodeURIComponent(projectId)}/loops`)
      const loops = data.loops ?? [...(data.active ?? []), ...(data.recent ?? [])]
      return loops.map((loop) => mapRemoteLoop(loop as Record<string, unknown>))
    },
    async getLoop(projectId, loopName) {
      try {
        const data = await request<Record<string, unknown>>(`/api/v1/projects/${encodeURIComponent(projectId)}/loops/${encodeURIComponent(loopName)}`)
        return mapRemoteLoop(data)
      } catch {
        return null
      }
    },
    async cancelLoop(projectId, loopName) {
      try {
        await request(`/api/v1/projects/${encodeURIComponent(projectId)}/loops/${encodeURIComponent(loopName)}`, { method: 'DELETE' })
        return true
      } catch {
        return false
      }
    },
    async restartLoop(projectId, loopName, force) {
      try {
        const data = await request<{ sessionId?: string }>(`/api/v1/projects/${encodeURIComponent(projectId)}/loops/${encodeURIComponent(loopName)}/restart`, {
          method: 'POST',
          body: JSON.stringify({ force }),
        })
        return data.sessionId ?? null
      } catch {
        return null
      }
    },
    async readGraphStatus(projectId, cwd) {
      try {
        const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
        const data = await request<{ status: GraphStatusPayload | null }>(`/api/v1/projects/${encodeURIComponent(projectId)}/graph/status${query}`)
        return data.status
      } catch {
        return null
      }
    },
    async readPreferences(projectId) {
      try {
        return await request<ExecutionPreferences>(`/api/v1/projects/${encodeURIComponent(projectId)}/models/preferences`)
      } catch {
        return null
      }
    },
    async writePreferences(projectId, prefs) {
      const mode = prefs.mode === 'Execute here'
        ? 'execute-here'
        : prefs.mode === 'Loop'
          ? 'loop'
          : prefs.mode === 'Loop (worktree)'
            ? 'loop-worktree'
            : 'new-session'
      try {
        await request(`/api/v1/projects/${encodeURIComponent(projectId)}/models/preferences`, {
          method: 'PUT',
          body: JSON.stringify({ mode, executionModel: prefs.executionModel, auditorModel: prefs.auditorModel }),
        })
        return true
      } catch {
        return false
      }
    },
    async listModels(projectId) {
      return await request(`/api/v1/projects/${encodeURIComponent(projectId)}/models`)
    },
    async executePlan(projectId, sessionId, body) {
      try {
        return await request(`/api/v1/projects/${encodeURIComponent(projectId)}/plans/session/${encodeURIComponent(sessionId)}/execute`, {
          method: 'POST',
          body: JSON.stringify(body),
        })
      } catch {
        return null
      }
    },
    async startLoop(projectId, body) {
      try {
        return await request(`/api/v1/projects/${encodeURIComponent(projectId)}/loops`, {
          method: 'POST',
          body: JSON.stringify(body),
        })
      } catch {
        return null
      }
    },
  }
}
