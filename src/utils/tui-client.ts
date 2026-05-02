import type { ExecutionPreferences } from './tui-execution-preferences'
import type { LoopInfo } from './tui-refresh-helpers'
import type { GraphStatusPayload } from './graph-status-store'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import { appendFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { resolveLogPath } from '../storage'
import { readPlan, readPlanForAnyProject, readProjectIdForSession } from './tui-plan-store'
import { fetchAvailableModels } from './tui-models'
import { readExecutionPreferences, writeExecutionPreferences } from './tui-execution-preferences'
import { parseModelString } from './model-fallback'
import { launchFreshLoop } from './loop-launch'
import {
  encodeRequest,
  decodeReply,
  newRid,
} from '../api/bus-protocol'

export type ApiExecutionMode = 'new-session' | 'execute-here' | 'loop' | 'loop-worktree'

export interface ExecutionContext {
  preferences: ExecutionPreferences | null
  models: {
    providers: unknown[]
    connectedProviderIds?: string[]
    configuredProviderIds?: string[]
    favoriteModels?: string[]
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
    ): Promise<{ sessionId?: string; loopName?: string; worktreeDir?: string; workspaceId?: string } | null>
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

const DIRECTORY_RESOLUTION_ATTEMPTS = 3
const DIRECTORY_RESOLUTION_RETRY_MS = 100
const DISCOVERY_RPC_TIMEOUT_MS = 1000
const RPC_TIMEOUT_MS = 5000

function tuiDebug(message: string): void {
  try {
    const file = resolveLogPath()
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${new Date().toISOString()} DEBUG [OpenCodeForge:TUI] ${message}\n`, 'utf-8')
  } catch {
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

interface PendingRpc {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export async function connectForgeProject(
  api: TuiPluginApi,
  directory?: string,
): Promise<ForgeProjectClient | null> {
  const pending = new Map<string, PendingRpc>()
  tuiDebug(`connect start directory=${directory ?? 'none'}`)

  api.event.on('tui.command.execute', (event) => {
    const command = event.properties?.command as string | undefined
    if (!command) {
      tuiDebug('event received without command')
      return
    }

    const reply = decodeReply(command)
    if (!reply) {
      if (command.startsWith('forge.')) tuiDebug(`event decode skipped command=${command.slice(0, 48)}`)
      return
    }

    const pendingRpc = pending.get(reply.rid)
    if (!pendingRpc) {
      tuiDebug(`reply received without pending rid=${reply.rid} status=${reply.status}`)
      return
    }

    tuiDebug(`reply matched rid=${reply.rid} status=${reply.status}`)

    clearTimeout(pendingRpc.timer)
    pending.delete(reply.rid)

    if (reply.status === 'ok') {
      pendingRpc.resolve(reply.data)
    } else {
      // For plan.read, errors should resolve to null (swallowed)
      // This is handled at the call site
      pendingRpc.reject(new Error(reply.message))
    }
  })

  async function discoverProjectIdByDirectory(): Promise<string | null> {
    let projectId: string | null = null

    for (let attempt = 0; attempt < DIRECTORY_RESOLUTION_ATTEMPTS; attempt += 1) {
      try {
        const rid = newRid()
        tuiDebug(`discovery publish attempt=${attempt + 1} rid=${rid} directory=${directory ?? 'none'}`)
        const result = await new Promise<{ projects: Array<{ id: string; directory?: string | null }> }>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(rid)
            tuiDebug(`discovery timeout rid=${rid}`)
            reject(new Error('forge rpc timeout'))
          }, DISCOVERY_RPC_TIMEOUT_MS)

          pending.set(rid, { resolve: resolve as (data: unknown) => void, reject, timer })

          api.client.tui.publish({
            directory,
            body: {
              type: 'tui.command.execute',
              properties: {
                command: encodeRequest({
                  verb: 'projects.list',
                  rid,
                  directory,
                  projectId: '',
                  params: {},
                  body: directory ? { directory } : {},
                }),
              },
            },
          }).catch((err) => {
            clearTimeout(timer)
            pending.delete(rid)
            tuiDebug(`discovery publish failed rid=${rid} error=${err instanceof Error ? err.message : String(err)}`)
            reject(err)
          })
        })

        tuiDebug(`discovery result rid=${rid} count=${result.projects.length}`)

        if (directory) {
          const matched = result.projects.find((p) => p.directory === directory)
          if (matched) {
            projectId = matched.id
            break
          }
        } else {
          projectId = result.projects[0]?.id ?? null
          if (projectId) break
        }
      } catch (err) {
        tuiDebug(`discovery attempt failed attempt=${attempt + 1} error=${err instanceof Error ? err.message : String(err)}`)
      }

      if (attempt < DIRECTORY_RESOLUTION_ATTEMPTS - 1) {
        await sleep(DIRECTORY_RESOLUTION_RETRY_MS)
      }
    }

    if (!projectId) {
      return null
    }

    return projectId
  }

  async function rpc<T>(
    verb: string,
    params: Record<string, string>,
    body?: unknown,
    timeoutMs = RPC_TIMEOUT_MS,
  ): Promise<T> {
    const rid = newRid()

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(rid)
        reject(new Error('forge rpc timeout'))
      }, timeoutMs)

      pending.set(rid, { resolve: resolve as (data: unknown) => void, reject, timer })

      api.client.tui.publish({
        directory,
        body: {
          type: 'tui.command.execute',
          properties: {
            command: encodeRequest({
              verb,
              rid,
              directory,
              projectId: projectId ?? undefined,
              params,
              body,
            }),
          },
        },
      }).catch((err) => {
        clearTimeout(timer)
        pending.delete(rid)
        reject(err)
      })
    })
  }

  const projectId = await discoverProjectIdByDirectory()
  if (!projectId) {
    tuiDebug(`discovery failed; continuing with cwd routing directory=${directory ?? 'none'}`)
  }

  const plan: ForgeProjectClient['plan'] = {
    async read(sessionId) {
      const localPlan = projectId ? readPlan(projectId, sessionId) : readPlanForAnyProject(sessionId)
      if (localPlan) {
        tuiDebug(`plan.read local hit session=${sessionId} projectId=${projectId || 'any'}`)
        return localPlan
      }

      try {
        const data = await rpc<{ content: string }>(
          'plan.read.session',
          { sessionId },
          undefined,
        )
        return data.content
      } catch {
        const fallbackPlan = readPlanForAnyProject(sessionId)
        if (fallbackPlan) {
          tuiDebug(`plan.read any-project fallback hit session=${sessionId}`)
          return fallbackPlan
        }
        tuiDebug(`plan.read miss session=${sessionId} projectId=${projectId || 'none'}`)
        return null
      }
    },
    async write(sessionId, content) {
      try {
        await rpc('plan.write.session', { sessionId }, { content })
        return true
      } catch {
        return false
      }
    },
    async delete(sessionId) {
      try {
        await rpc('plan.delete.session', { sessionId }, undefined)
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

      if (req.mode === 'loop' || req.mode === 'loop-worktree') {
        const loopProjectId = projectId || readProjectIdForSession(sessionId) || ''
        const loopDirectory = directory ?? api.state.path.directory
        const result = await launchFreshLoop({
          planText: req.plan,
          title: req.title,
          directory: loopDirectory,
          projectId: loopProjectId,
          isWorktree: req.mode === 'loop-worktree',
          v2: api.client,
          executionModel: req.executionModel,
          auditorModel: req.auditorModel,
          hostSessionId: sessionId,
          skipSandboxWait: true,
        })

        if (!result) return null
        if (projectId) writeExecutionPreferences(projectId, prefs)
        return {
          sessionId: result.sessionId,
          loopName: result.loopName,
          worktreeDir: result.worktreeDir,
          workspaceId: result.workspaceId,
        }
      }

      let result: { sessionId?: string; loopName?: string; worktreeDir?: string; workspaceId?: string } | null
      try {
        result = await rpc(
          'plan.execute',
          { sessionId },
          {
            mode: req.mode,
            title: req.title,
            plan: req.plan,
            executionModel: req.executionModel,
            auditorModel: req.auditorModel,
            targetSessionId: req.targetSessionId,
          },
        )
      } catch {
        return null
      }

      // Best-effort prefs save
      try {
        const mode = mapPrefMode(prefs.mode)
        await rpc(
          'models.prefs.write',
          projectId ? { projectId } : {},
          {
            mode,
            executionModel: prefs.executionModel,
            auditorModel: prefs.auditorModel,
          },
        )
      } catch {
        /* ignore */
      }

      return result
    },
  }

  const loops: ForgeProjectClient['loops'] = {
    async list() {
      try {
        const data = await rpc<{ loops?: unknown[]; active?: unknown[]; recent?: unknown[] }>(
          'loops.list',
          {},
          undefined,
        )
        const arr = data.loops ?? [...(data.active ?? []), ...(data.recent ?? [])]
        return arr.map((l) => mapRemoteLoop(l as Record<string, unknown>))
      } catch {
        return []
      }
    },
    async get(loopName) {
      try {
        const data = await rpc<Record<string, unknown>>(
          'loops.get',
          { loopName },
          undefined,
        )
        return mapRemoteLoop(data)
      } catch {
        return null
      }
    },
    async cancel(loopName) {
      try {
        await rpc('loops.cancel', { loopName }, undefined)
        return true
      } catch {
        return false
      }
    },
    async restart(loopName, force) {
      try {
        const data = await rpc<{ sessionId?: string }>(
          'loops.restart',
          { loopName },
          { force },
        )
        return data.sessionId ?? null
      } catch {
        return null
      }
    },
    async start(req) {
      try {
        const loopProjectId = projectId || (req.hostSessionId ? readProjectIdForSession(req.hostSessionId) : null) || ''
        const loopDirectory = directory ?? api.state.path.directory
        const result = await launchFreshLoop({
          planText: req.plan,
          title: req.title,
          directory: loopDirectory,
          projectId: loopProjectId,
          isWorktree: req.worktree,
          v2: api.client,
          executionModel: req.executionModel,
          auditorModel: req.auditorModel,
          hostSessionId: req.hostSessionId,
          skipSandboxWait: true,
        })

        if (!result) return null
        return {
          sessionId: result.sessionId,
          loopName: result.loopName,
          worktreeDir: result.worktreeDir,
          workspaceId: result.workspaceId,
        }
      } catch {
        return null
      }
    },
  }

  return {
    projectId: projectId ?? '',
    plan,
    loops,
    async loadExecutionContext() {
      const [prefsResult, modelsResult] = await Promise.all([
        rpc<ExecutionPreferences>(
          'models.prefs.read',
          projectId ? { projectId } : {},
          undefined,
        ).catch(() => projectId ? readExecutionPreferences(projectId) : null),
        fetchAvailableModels(api),
      ])
      return { preferences: prefsResult, models: modelsResult }
    },
    async readGraphStatus(cwd) {
      try {
        const data = await rpc<{ status: GraphStatusPayload | null }>(
          'graph.status',
          projectId ? { projectId } : {},
          cwd ? { cwd } : {},
        )
        return data.status
      } catch {
        return null
      }
    },
  }
}
