import type { ExecutionPreferences } from './tui-execution-preferences'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import { appendFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { resolveLogPath } from '../storage'
import {
  fetchAvailableModels,
  readOpenCodeFavoriteModels,
  type SessionForRecents,
  type WorkspaceForRecents,
} from './tui-models'
import { deriveExecutionPreferencesFromWorkspaces } from './tui-execution-preferences'
import { parseModelString } from './model-fallback'
import { listConnectedWorkspaces } from './workspace-listing'
import { type ForgeLoopExtra } from '../services/execution'
import { buildLoopPermissionRuleset } from '../constants/loop'
import { getForgeWorkspaceLoopName, removeExistingForgeLoopWorkspaces, getWorktreeProjectPreconditionError } from '../workspace/forge-worktree'
import { classifyWorkspaceCreateThrow } from '../workspace/workspace-create-error'
import { fetchLoopsList } from './tui-loop-store'
import { decomposeDeterministically } from '../services/deterministic-decomposer'
import { buildSectionInitialPromptText } from '../loop/prompts'
import { extractPlanExecutionMetadata, sanitizeLoopName } from './plan-execution'
import { createForgeClient } from '../client/sdk-adapter'
import type { ForgeClient } from '../client/port'
import { fetchLatestPlanForSession } from './plan-from-messages'

export type ApiExecutionMode = 'new-session' | 'execute-here' | 'loop'

/**
 * Builds a consistent model+variant payload for promptAsync calls.
 * Centralizes the spreading logic so each call site doesn't reinvent it.
 */
export function buildPromptModelSelection(
  model: { providerID: string; modelID: string } | undefined,
  variant?: string,
): { model?: { providerID: string; modelID: string }; variant?: string } {
  return {
    ...(model ? { model } : {}),
    ...(variant ? { variant } : {}),
  }
}

export interface ExecutionContext {
  preferences: ExecutionPreferences | null
  models: {
    providers: unknown[]
    connectedProviderIds?: string[]
    configuredProviderIds?: string[]
    error?: string
  }
  /**
   * Sessions for the current project, supplied to
   * `deriveRecentModels`. Sourced from
   * `client.experimental.session.list(...)`. Always present (defaults to
   * `[]` on fetch failure).
   */
  sessions: SessionForRecents[]
  /**
   * Forge workspaces for the current project, supplied to both
   * `deriveExecutionPreferencesFromWorkspaces` and (as the auditor-model
   * layer) `deriveRecentModels`. Sourced from
   * `client.experimental.workspace.list(...)`. Always present.
   */
  workspaces: WorkspaceForRecents[]
  /**
   * OpenCode favorite model fullnames, probed from
   * `api.state` via {@link readOpenCodeFavoriteModels}. Empty array when
   * the running TUI version does not expose them.
   */
  openCodeFavorites: string[]
  /**
   * The user's global default model (`api.state.config?.model`). Surfaced
   * last in the layered recents list so it is always selectable.
   */
  openCodeDefault: string | undefined
}

export interface ExecutePlanRequest {
  mode: ApiExecutionMode
  title: string
  loopName?: string
  plan: string
  executionModel?: string
  auditorModel?: string
  executionVariant?: string
  auditorVariant?: string
  targetSessionId?: string
}

function nextAvailableLoopName(baseName: string, names: string[]): string {
  let candidate = baseName
  let suffix = 1
  while (names.includes(candidate)) {
    candidate = `${baseName}-${suffix}`
    suffix += 1
  }
  return candidate
}

export async function reserveTuiLoopName(client: ForgeClient, projectId: string | null, baseName: string): Promise<string> {
  const names = new Set<string>()
  if (projectId) {
    for (const loop of fetchLoopsList(projectId)) {
      names.add(loop.name)
    }
  }
  try {
    const entries = (await client.workspace.list()) as Array<{ name?: string; extra?: Record<string, unknown> | null }>
    for (const entry of entries) {
      if (entry.name) names.add(entry.name)
      const loopName = getForgeWorkspaceLoopName(entry)
      if (loopName) names.add(loopName)
    }
    return nextAvailableLoopName(baseName, [...names])
  } catch {
    return nextAvailableLoopName(baseName, [...names])
  }
}

export interface ForgeProjectClient {
  readonly projectId: string

  plan: {
    /**
     * Execute workflow: forwards the user's chosen mode + models + plan to
     * the server. For loop mode the model selection is persisted on the
     * server inside the new workspace's `extra.forgeLoop` envelope — that
     * record IS the source of truth for "last used preferences" and
     * "recent models" on the next dialog open, so there is no separate
     * TUI-side write.
     */
    execute(
      sessionId: string,
      req: ExecutePlanRequest,
    ): Promise<{ sessionId?: string; loopName?: string; worktreeDir?: string; workspaceId?: string } | { error: string } | null>
  }

  workspaces: {
    list(): Promise<Array<{ id: string; name: string; type: string; branch?: string; directory?: string; timeUsed?: number }>>
    status(): Promise<Record<string, string>>
  }

  /**
   * Navigate the TUI to a session (route-first, SDK fallback). Routes through
   * the same {@link ForgeClient} port as every other call.
   */
  selectSession(sessionId: string, workspaceId?: string): Promise<void>

  /**
   * Read the latest marked plan from a session's chat history, or `null` when
   * none is found. Routes through the same {@link ForgeClient} port.
   */
  loadLatestPlan(sessionId: string): Promise<string | null>

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
  client: ForgeClient,
  workspaceId: string,
  timeoutMs = 5000,
  pollIntervalMs = 100,
): Promise<AwaitWorkspaceConnectedResult> {
  const start = Date.now()
  let lastStatus: string | undefined
  try {
    while (Date.now() - start < timeoutMs) {
      try {
        const entries = (await client.workspace.status()) as Array<{ workspaceID: string; status: string }>
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

function getWorkspacePluginSettleMs(): number {
  const raw = process.env.FORGE_TUI_WORKSPACE_SETTLE_MS
  if (!raw) return 750
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 750
}

async function waitForWorkspacePluginSettle(workspaceId: string): Promise<void> {
  const settleMs = getWorkspacePluginSettleMs()
  if (settleMs <= 0) return
  tuiDebug(`waitForWorkspacePluginSettle: workspace=${workspaceId} delayMs=${settleMs}`)
  await new Promise<void>((resolve) => setTimeout(resolve, settleMs))
}

function buildTuiLoopInitialPrompt(planText: string): string {
  const sections = decomposeDeterministically(planText, { maxSections: 12 })
  const firstSection = sections[0]
  if (!firstSection) return planText

  return buildSectionInitialPromptText({
    currentSectionIndex: 0,
    totalSections: sections.length,
    iteration: 1,
    maxIterations: 50,
    sectionContent: firstSection.content,
  })
}

export interface LaunchTuiLoopOptions {
  client: ForgeClient
  directory: string | undefined
  projectId: string | null
  requestedLoopName: string
  /**
   * When true, `requestedLoopName` was already reserved via
   * {@link reserveTuiLoopName} and is used verbatim. Avoids a second
   * reservation round-trip and guarantees the caller's derived artifacts
   * (e.g. the pushed sync ref) match the launched loop name.
   */
  loopNameReserved?: boolean
  title: string
  plan: string
  executionModel?: string
  auditorModel?: string
  executionVariant?: string
  auditorVariant?: string
  hostSessionId?: string
  allowDirectories?: string[]
  /** Extra workspace fields merged into extra (e.g. startRef/syncRef/gitRemote). */
  extraWorkspaceFields?: Record<string, unknown>
  /** Merged into the forgeLoop envelope (e.g. sandboxEnabled=false for remote). */
  forgeLoopOverrides?: Partial<ForgeLoopExtra>
  /** Called after promptAsync succeeds; local path navigates the TUI, remote omits. */
  onLaunched?: (sessionId: string, workspaceId: string) => Promise<void>
  /** Poll interval for the workspace-connected wait. Remote launches widen this to avoid hammering the server over the network. Default 100ms. */
  connectPollIntervalMs?: number
  debug?: (message: string) => void
}

export async function launchTuiLoop(
  opts: LaunchTuiLoopOptions,
): Promise<{ sessionId: string; loopName: string; worktreeDir?: string; workspaceId: string } | { error: string } | null> {
  const debug = opts.debug ?? tuiDebug

  const committedError = getWorktreeProjectPreconditionError(opts.projectId)
  if (committedError) {
    debug(`launchTuiLoop: blocked — ${committedError}`)
    return { error: committedError }
  }

  const loopName = opts.loopNameReserved
    ? opts.requestedLoopName
    : await reserveTuiLoopName(opts.client, opts.projectId, opts.requestedLoopName)
  debug(`launchTuiLoop: inline plan (planText.length=${opts.plan.length}) hostSession=${opts.hostSessionId ?? 'none'} loop=${loopName}`)
  const createdAt = Date.now()
  const forgeLoop: ForgeLoopExtra = {
    hostSessionId: opts.hostSessionId,
    title: opts.title,
    executionModel: opts.executionModel,
    auditorModel: opts.auditorModel,
    executionVariant: opts.executionVariant,
    auditorVariant: opts.auditorVariant,
    planSource: 'inline',
    planText: opts.plan,
    initialPromptOwner: 'tui',
    pendingAttachStartedAt: createdAt,
    ...opts.forgeLoopOverrides,
  }
  await removeExistingForgeLoopWorkspaces(opts.client, loopName, {
    log: (message) => debug(`launchTuiLoop: ${message}`),
    error: (message, err) => debug(`launchTuiLoop: ${message} ${err instanceof Error ? err.message : String(err)}`),
  })

  // Classify workspace.create failures separately to surface an actionable message
  let workspace
  try {
    workspace = await opts.client.workspace.create({
      type: 'forge',
      branch: null,
      extra: {
        loopName,
        projectDirectory: opts.directory,
        workspaceCreatedAt: createdAt,
        forgeLoop,
        ...opts.extraWorkspaceFields,
      },
    })
  } catch (err) {
    const classified = classifyWorkspaceCreateThrow(err)
    debug(`launchTuiLoop: workspace.create failed reason=${classified.reason} cause=${classified.cause ?? ''}`)
    return { error: classified.message }
  }

  try {
    await opts.client.workspace.syncList().catch(() => undefined)

    const connected = await awaitWorkspaceConnected(opts.client, workspace.id, 5000, opts.connectPollIntervalMs ?? 100)
    debug(`launchTuiLoop: workspace ${workspace.id} connected=${connected.connected} source=${connected.source} elapsedMs=${connected.elapsedMs} lastStatus=${connected.lastStatus ?? 'unknown'}`)
    if (connected.connected) {
      await waitForWorkspacePluginSettle(workspace.id)
    }

    const parsedModel = parseModelString(opts.executionModel)
    const permission = buildLoopPermissionRuleset({ allowDirectories: opts.allowDirectories })
    const session = await opts.client.session.create({
      workspaceID: workspace.id,
      title: loopName,
      directory: workspace.directory ?? undefined,
      permission,
    })
    const promptText = buildTuiLoopInitialPrompt(opts.plan)

    const promptInput = {
      sessionID: session.id,
      directory: workspace.directory ?? undefined,
      workspace: workspace.id,
      agent: 'code' as const,
      parts: [{ type: 'text' as const, text: promptText }],
      ...buildPromptModelSelection(parsedModel, opts.executionVariant),
    }
    try {
      await opts.client.session.promptAsync(promptInput)
    } catch (err) {
      debug(`launchTuiLoop: promptAsync failed session=${session.id} workspace=${workspace.id} error=${err instanceof Error ? err.message : String(err)}`)
      await opts.client.workspace.remove({ id: workspace.id }).catch(() => undefined)
      return null
    }
    debug(`launchTuiLoop: promptAsync ok session=${session.id} workspace=${workspace.id}`)

    await opts.onLaunched?.(session.id, workspace.id)

    await opts.client.workspace.syncList().catch(() => undefined)

    return {
      sessionId: session.id,
      loopName,
      worktreeDir: workspace.directory ?? undefined,
      workspaceId: workspace.id,
    }
  } catch (err) {
    debug(`launchTuiLoop: post-create flow failed error=${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

export async function selectTuiSession(api: TuiPluginApi, client: ForgeClient, sessionId: string, workspaceId?: string): Promise<void> {
  try {
    api.route.navigate('session', { sessionID: sessionId })
    tuiDebug(`selectTuiSession: route.navigate session=${sessionId} workspace=${workspaceId ?? 'none'}`)
    return
  } catch (err) {
    tuiDebug(`selectTuiSession: route.navigate failed session=${sessionId} error=${(err as Error).message}`)
  }

  try {
    await client.tui.selectSession({
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
  allowExternalDirectories?: string[],
): Promise<ForgeProjectClient | null> {
  tuiDebug(`connect start directory=${directory ?? 'none'}`)

  // Single client path: every SDK call in this project client goes through the
  // typed ForgeClient port wrapping the TUI's v2 client.
  const client = createForgeClient(api.client)

  let projectId: string | null = null

  try {
    // Prefer OpenCode's own directory-scoped resolution. project.current handles
    // multi-checkout repos (same project id, different worktree paths): the
    // project row keeps only the first-registered checkout in `worktree` while
    // additional checkouts land in `sandboxes`, so an exact `worktree === dir`
    // match on the list silently fails for the secondary checkout.
    const current = await client.project.current(directory ? { directory } : undefined)
    projectId = current?.id ?? null
  } catch {
    projectId = null
  }

  if (!projectId) {
    try {
      const projects = (await client.project.list()) as Array<{ id: string; worktree: string; sandboxes?: string[] }>
      const matched = directory
        ? projects.find((p) => p.worktree === directory || p.sandboxes?.includes(directory))
        : projects[0]
      projectId = matched?.id ?? null
    } catch {
      projectId = null
    }
  }

  if (!projectId) {
    tuiDebug(`discovery failed; continuing with cwd routing directory=${directory ?? 'none'}`)
  } else {
    tuiDebug(`discovery success projectId=${projectId}`)
  }

  const plan: ForgeProjectClient['plan'] = {
    async execute(sessionId, req) {
      const parsedModel = parseModelString(req.executionModel)

      if (req.mode === 'execute-here') {
        const prompt = `The architect agent has created an implementation plan in this conversation above. You are now the code agent taking over this session. Your job is to execute the plan — edit files, run commands, create tests, and implement every phase. Do NOT just describe or summarize the changes. Actually make them.\n\nPlan reference: ${req.plan}`

        const modelVariant = buildPromptModelSelection(parsedModel, req.executionVariant)
        try {
          await client.session.promptAsync({
            sessionID: req.targetSessionId ?? sessionId,
            directory,
            agent: 'code',
            ...modelVariant,
            parts: [{ type: 'text' as const, text: prompt }],
          })
        } catch {
          return null
        }
        return { sessionId: req.targetSessionId ?? sessionId }
      }

      if (req.mode === 'new-session') {
        try {
          const session = await client.session.create({
            title: req.title.length > 60 ? `${req.title.substring(0, 57)}...` : req.title,
            directory,
          })
          const modelVariant = buildPromptModelSelection(parsedModel, req.executionVariant)
          await client.session.promptAsync({
            sessionID: session.id,
            directory,
            agent: 'code',
            ...modelVariant,
            parts: [{ type: 'text' as const, text: req.plan }],
          })
          return { sessionId: session.id }
        } catch {
          return null
        }
      }

      if (req.mode === 'loop') {
        return await launchTuiLoop({
          client,
          directory,
          projectId,
          requestedLoopName: req.loopName ?? (req.title ? sanitizeLoopName(req.title) : extractPlanExecutionMetadata(req.plan).executionName),
          title: req.title,
          plan: req.plan,
          executionModel: req.executionModel,
          auditorModel: req.auditorModel,
          executionVariant: req.executionVariant,
          auditorVariant: req.auditorVariant,
          hostSessionId: sessionId || undefined,
          allowDirectories: allowExternalDirectories,
          onLaunched: (sid, wid) => selectTuiSession(api, client, sid, wid),
          debug: tuiDebug,
        }) ?? null
      }

      return null
    },
  }

  const workspaces: ForgeProjectClient['workspaces'] = {
    async list() {
      try {
        return await listConnectedWorkspaces(client.workspace)
      } catch {
        return []
      }
    },
    async status() {
      try {
        const entries = (await client.workspace.status()) as Array<{ workspaceID: string; status: string }>
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
    selectSession(sessionId, workspaceId) {
      return selectTuiSession(api, client, sessionId, workspaceId)
    },
    loadLatestPlan(sessionId) {
      return fetchLatestPlanForSession(client, sessionId, directory)
    },
    async loadExecutionContext() {
      const [sessionsResult, workspacesResult, modelsResult] = await Promise.all([
        client.session.list({ directory }).catch(() => null),
        client.workspace.list({ directory }).catch(() => null),
        fetchAvailableModels(api, client),
      ])
      const sessions = (sessionsResult ?? []) as unknown as SessionForRecents[]
      const workspaceList = (workspacesResult ?? []) as unknown as WorkspaceForRecents[]
      const preferences = projectId
        ? deriveExecutionPreferencesFromWorkspaces(projectId, workspaceList)
        : null
      const openCodeFavorites = readOpenCodeFavoriteModels(api)
      const openCodeDefault =
        typeof (api.state.config as { model?: unknown } | undefined)?.model === 'string'
          ? ((api.state.config as { model?: string }).model as string)
          : undefined
      return {
        preferences,
        models: modelsResult,
        sessions,
        workspaces: workspaceList,
        openCodeFavorites,
        openCodeDefault,
      }
    },
  }
}
