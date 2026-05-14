import type { ExecutionPreferences } from './tui-execution-preferences'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import { appendFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { resolveLogPath } from '../storage'
import { readPlan, readPlanForAnyProject, writePlan, deletePlan } from './tui-plan-store'
import { fetchAvailableModels } from './tui-models'
import { readExecutionPreferences, writeExecutionPreferences } from './tui-execution-preferences'
import { parseModelString } from './model-fallback'
import { listConnectedWorkspaces, type WorkspaceListApi } from './workspace-listing'
import { type ForgeLoopExtra } from '../services/execution'

export type ApiExecutionMode = 'new-session' | 'execute-here' | 'loop'

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
    ): Promise<{ sessionId?: string; loopName?: string; worktreeDir?: string; workspaceId?: string } | null>
  }

  workspaces: {
    list(): Promise<Array<{ id: string; name: string; type: string; branch?: string; directory?: string; timeUsed?: number }>>
    status(): Promise<Record<string, string>>
  }

  /** Single round-trip pair: read preferences and list models. */
  loadExecutionContext(): Promise<ExecutionContext>
}

function tuiDebug(message: string): void {
  try {
    const file = resolveLogPath()
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${new Date().toISOString()} DEBUG [OpenCodeForge:TUI] ${message}\n`, 'utf-8')
  } catch {
  }
}

export interface AwaitWorkspaceConnectedResult {
  connected: boolean
  source: 'cached' | 'polled' | 'timeout' | 'error'
  elapsedMs: number
  lastStatus?: string
}

/**
 * Polls `experimental.workspace.status` until the target workspace reports
 * `connected`, or until the timeout elapses. Mirrors the awaitConnected
 * gating pattern from `src/services/execution.ts:721` so that
 * `tui.selectSession` does not fire before the user's TUI has adopted the
 * workspace (which causes the call to silently no-op).
 */
export async function awaitWorkspaceConnected(
  api: TuiPluginApi,
  workspaceId: string,
  timeoutMs = 5000,
  pollIntervalMs = 100,
): Promise<AwaitWorkspaceConnectedResult> {
  const start = Date.now()
  let lastStatus: string | undefined
  try {
    while (Date.now() - start < timeoutMs) {
      try {
        const result = await api.client.experimental.workspace.status()
        const entries = ((result as { data?: unknown } | undefined)?.data ?? []) as Array<{ workspaceID: string; status: string }>
        const entry = entries.find((e) => e.workspaceID === workspaceId)
        if (entry) {
          lastStatus = entry.status
          if (entry.status === 'connected') {
            const elapsedMs = Date.now() - start
            const source: AwaitWorkspaceConnectedResult['source'] = elapsedMs <= pollIntervalMs ? 'cached' : 'polled'
            tuiDebug(`awaitWorkspaceConnected: workspace=${workspaceId} connected elapsedMs=${elapsedMs} source=${source}`)
            return { connected: true, source, elapsedMs, lastStatus }
          }
        }
      } catch (err) {
        tuiDebug(`awaitWorkspaceConnected: status() failed workspace=${workspaceId} error=${(err as Error).message}`)
      }
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs))
    }
    const elapsedMs = Date.now() - start
    tuiDebug(`awaitWorkspaceConnected: workspace=${workspaceId} timeout after ${elapsedMs}ms lastStatus=${lastStatus ?? 'unknown'}`)
    return { connected: false, source: 'timeout', elapsedMs, lastStatus }
  } catch (err) {
    tuiDebug(`awaitWorkspaceConnected: unexpected error workspace=${workspaceId} error=${(err as Error).message}`)
    return { connected: false, source: 'error', elapsedMs: Date.now() - start, lastStatus }
  }
}

function deriveLoopNameFromTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60)
}

export async function selectTuiSession(api: TuiPluginApi, sessionId: string, workspaceId?: string): Promise<void> {
  try {
    api.route.navigate('session', { sessionID: sessionId })
    tuiDebug(`selectTuiSession: route.navigate session=${sessionId} workspace=${workspaceId ?? 'none'}`)
    return
  } catch (err) {
    tuiDebug(`selectTuiSession: route.navigate failed session=${sessionId} error=${(err as Error).message}`)
  }

  try {
    await api.client.tui.selectSession({
      sessionID: sessionId,
      ...(workspaceId ? { workspace: workspaceId } : {}),
    })
    tuiDebug(`selectTuiSession: sdk.selectSession session=${sessionId} workspace=${workspaceId ?? 'none'}`)
  } catch (err) {
    tuiDebug(`selectTuiSession: sdk.selectSession failed session=${sessionId} error=${(err as Error).message}`)
  }
}

export async function connectForgeProject(
  api: TuiPluginApi,
  directory?: string,
): Promise<ForgeProjectClient | null> {
  tuiDebug(`connect start directory=${directory ?? 'none'}`)

  let projectId: string | null = null

  try {
    const projectsRes = await api.client.project.list()
    const projects = (projectsRes?.data ?? []) as Array<{ id: string; worktree: string }>
    const matched = directory ? projects.find((p) => p.worktree === directory) : projects[0]
    projectId = matched?.id ?? null
  } catch {
    projectId = null
  }

  if (!projectId) {
    tuiDebug(`discovery failed; continuing with cwd routing directory=${directory ?? 'none'}`)
  } else {
    tuiDebug(`discovery success projectId=${projectId}`)
  }

  const plan: ForgeProjectClient['plan'] = {
    async read(sessionId) {
      const localPlan = projectId ? readPlan(projectId, sessionId) : readPlanForAnyProject(sessionId)
      if (localPlan) {
        tuiDebug(`plan.read local hit session=${sessionId} projectId=${projectId || 'any'}`)
        return localPlan
      }

      const fallbackPlan = readPlanForAnyProject(sessionId)
      if (fallbackPlan) {
        tuiDebug(`plan.read any-project fallback hit session=${sessionId}`)
        return fallbackPlan
      }
      tuiDebug(`plan.read miss session=${sessionId} projectId=${projectId || 'none'}`)
      return null
    },
    async write(sessionId, content) {
      if (!projectId) return false
      try {
        writePlan(projectId, sessionId, content)
        return true
      } catch {
        return false
      }
    },
    async delete(sessionId) {
      if (!projectId) return false
      try {
        deletePlan(projectId, sessionId)
        return true
      } catch {
        return false
      }
    },
    async execute(sessionId, req, prefs) {
      const parsedModel = parseModelString(req.executionModel)

      if (req.mode === 'execute-here') {
        const prompt = `The architect agent has created an implementation plan in this conversation above. You are now the code agent taking over this session. Your job is to execute the plan — edit files, run commands, create tests, and implement every phase. Do NOT just describe or summarize the changes. Actually make them.\n\nPlan reference: ${req.plan}`

        const result = parsedModel
          ? await api.client.session.promptAsync({
            sessionID: req.targetSessionId ?? sessionId,
            directory,
            agent: 'code',
            model: parsedModel,
            parts: [{ type: 'text' as const, text: prompt }],
          })
          : await api.client.session.promptAsync({
            sessionID: req.targetSessionId ?? sessionId,
            directory,
            agent: 'code',
            parts: [{ type: 'text' as const, text: prompt }],
          })

        if (result.error) return null
        if (projectId) writeExecutionPreferences(projectId, prefs)
        return { sessionId: req.targetSessionId ?? sessionId }
      }

      if (req.mode === 'new-session') {
        const createResult = await api.client.session.create({
          title: req.title.length > 60 ? `${req.title.substring(0, 57)}...` : req.title,
          directory,
        })

        if (createResult.error || !createResult.data) return null

        const newSessionId = createResult.data.id
        const result = parsedModel
          ? await api.client.session.promptAsync({
            sessionID: newSessionId,
            directory,
            agent: 'code',
            model: parsedModel,
            parts: [{ type: 'text' as const, text: req.plan }],
          })
          : await api.client.session.promptAsync({
            sessionID: newSessionId,
            directory,
            agent: 'code',
            parts: [{ type: 'text' as const, text: req.plan }],
          })

        if (result.error) return null
        if (projectId) writeExecutionPreferences(projectId, prefs)
        return { sessionId: newSessionId }
      }

      if (req.mode === 'loop') {
        const loopName = deriveLoopNameFromTitle(req.title)
        tuiDebug(`plan.execute(loop): inline plan (planText.length=${req.plan.length}) hostSession=${sessionId ?? 'none'} loop=${loopName}`)
        const forgeLoop: ForgeLoopExtra = {
          loopName,
          hostSessionId: sessionId || undefined,
          title: req.title,
          executionModel: req.executionModel,
          auditorModel: req.auditorModel,
          planSource: 'inline',
          planText: req.plan,
        }
        try {
          const wsRes = await api.client.experimental.workspace.create({
            type: 'forge',
            branch: null,
            extra: { loopName, projectDirectory: directory, forgeLoop },
          })
          if (wsRes.error || !wsRes.data) return null
          const workspace = wsRes.data

          await api.client.experimental.workspace.syncList().catch(() => undefined)

          const sesRes = await api.client.session.create({
            workspaceID: workspace.id,
            title: req.title.length > 60 ? `${req.title.substring(0, 57)}...` : req.title,
            directory: workspace.directory ?? undefined,
          })
          if (sesRes.error || !sesRes.data) return null
          const session = sesRes.data

          const connected = await awaitWorkspaceConnected(api, workspace.id, 5000, 100)
          tuiDebug(`plan.execute(loop): workspace ${workspace.id} connected=${connected.connected} source=${connected.source} elapsedMs=${connected.elapsedMs} lastStatus=${connected.lastStatus ?? 'unknown'}`)

          await selectTuiSession(api, session.id, workspace.id)

          await api.client.experimental.workspace.syncList().catch(() => undefined)

          if (projectId) writeExecutionPreferences(projectId, prefs)

          return {
            sessionId: session.id,
            loopName,
            worktreeDir: workspace.directory ?? undefined,
            workspaceId: workspace.id,
          }
        } catch {
          return null
        }
      }

      return null
    },
  }

  const workspaces: ForgeProjectClient['workspaces'] = {
    async list() {
      try {
        return await listConnectedWorkspaces(api.client.experimental?.workspace as WorkspaceListApi | undefined)
      } catch {
        return []
      }
    },
    async status() {
      try {
        const data = await api.client.experimental.workspace.status()
        const entries = (data.data ?? []) as Array<{ workspaceID: string; status: string }>
        return Object.fromEntries(entries.map((s) => [s.workspaceID, s.status]))
      } catch {
        return {}
      }
    },
  }

  return {
    projectId: projectId ?? '',
    plan,
    workspaces,
    async loadExecutionContext() {
      const [prefsResult, modelsResult] = await Promise.all([
        Promise.resolve(projectId ? readExecutionPreferences(projectId) : null),
        fetchAvailableModels(api),
      ])
      return { preferences: prefsResult, models: modelsResult }
    },
  }
}
