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
import { resolveLoopLaunchPolicy, type LoopLaunchPolicy } from './loop-helpers'
import type { PluginConfig } from '../types'
import { getForgeWorkspaceLoopName, removeExistingForgeLoopWorkspaces, getWorktreeProjectPreconditionError } from '../workspace/forge-worktree'
import { classifyWorkspaceCreateThrow } from '../workspace/workspace-create-error'
import { fetchLoopsList, fetchStoredSessionLaunchSpec } from './tui-loop-store'
import { extractLaunchSpecMetadata, type SessionLaunchSpec } from './session-launch-spec'
import { decomposeDeterministically } from '../services/deterministic-decomposer'
import { buildSectionInitialPromptText } from '../loop/prompts'
import { sanitizeLoopName } from './plan-execution'
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
  spec: SessionLaunchSpec
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

export async function reserveTuiLoopName(
  client: ForgeClient,
  projectId: string | null,
  baseName: string,
  dbPath?: string,
): Promise<string> {
  const names = new Set<string>()
  if (projectId) {
    for (const loop of fetchLoopsList(projectId, dbPath)) {
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
   * Read the stored plan or goal brief for a session, falling back to a marked
   * plan in chat history, or return `null` when none is found.
   */
  loadLaunchSpec(sessionId: string): Promise<SessionLaunchSpec | null>

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
  const sections = decomposeDeterministically(planText)
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
  spec: SessionLaunchSpec
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
  /**
   * Plugin config used to resolve the loop launch policy (enabled flag and
   * defaultMaxIterations). When omitted, loops are assumed enabled and
   * defaultMaxIterations resolves to 0 (unbounded), matching the prior
   * behaviour. The resolved maxIterations is stamped onto the forgeLoop
   * envelope so the attach hook honours the launcher's promise instead of
   * diverging on the server's config view.
   */
  pluginConfig?: PluginConfig
  /**
   * When true, after provisioning the workspace the launcher polls the local
   * forge database for the loop row created by the attach hook and only
   * reports success once it appears with a non-terminal status. Surface for
   * local launches only: remote launches cannot observe the remote server's
   * database, so a cross-process handshake is out of scope here and the loop
   * row is created asynchronously in the remote plugin process.
   */
  awaitAttachAck?: boolean
  /** Override the attach-acknowledgement poll timeout (ms). Default 10000. */
  awaitAttachAckTimeoutMs?: number
  /** Override the attach-acknowledgement poll interval (ms). Default 100. */
  awaitAttachAckPollIntervalMs?: number
  /** Called after promptAsync succeeds; local path navigates the TUI, remote omits. */
  onLaunched?: (sessionId: string, workspaceId: string) => Promise<void>
  /** Poll interval for the workspace-connected wait. Remote launches widen this to avoid hammering the server over the network. Default 100ms. */
  connectPollIntervalMs?: number
  /** Override path to the forge SQLite database used for local loop/plan reads. When omitted, the default data dir is used. */
  dbPath?: string
  debug?: (message: string) => void
}

export async function launchTuiLoop(
  opts: LaunchTuiLoopOptions,
): Promise<{ sessionId: string; loopName: string; worktreeDir?: string; workspaceId: string } | { error: string }> {
  const debug = opts.debug ?? tuiDebug

  const committedError = getWorktreeProjectPreconditionError(opts.projectId)
  if (committedError) {
    debug(`launchTuiLoop: blocked — ${committedError}`)
    return { error: committedError }
  }

  // Resolve the loop launch policy once. This is the single point that keeps
  // the dialog and the execute-plan/execute-goal tool handlers from diverging
  // on `loop.enabled` and `loop.defaultMaxIterations`. The attach hook reads
  // the stamped `maxIterations` from the forgeLoop envelope (or its own
  // server-side policy as a fallback), so the launcher's promise is honoured.
  const policy: LoopLaunchPolicy = resolveLoopLaunchPolicy(opts.pluginConfig)
  if (!policy.enabled) {
    debug(`launchTuiLoop: blocked — loops disabled in plugin config`)
    return { error: 'Loops are disabled in plugin config' }
  }

  const loopName = opts.loopNameReserved
    ? opts.requestedLoopName
    : await reserveTuiLoopName(opts.client, opts.projectId, opts.requestedLoopName, opts.dbPath)
  debug(`launchTuiLoop: spec kind=${opts.spec.kind} text.length=${opts.spec.text.length} hostSession=${opts.hostSessionId ?? 'none'} loop=${loopName} maxIterations=${policy.maxIterations}`)
  const createdAt = Date.now()
  const forgeLoop: ForgeLoopExtra = {
    hostSessionId: opts.hostSessionId,
    title: opts.title,
    executionModel: opts.executionModel,
    auditorModel: opts.auditorModel,
    executionVariant: opts.executionVariant,
    auditorVariant: opts.auditorVariant,
    pendingAttachStartedAt: createdAt,
    maxIterations: policy.maxIterations,
    ...(opts.spec.kind === 'goal'
      ? { kind: 'goal' as const, goal: opts.spec.text, initialPromptOwner: 'server' as const }
      : { planSource: 'inline' as const, planText: opts.spec.text, initialPromptOwner: 'tui' as const }),
    ...opts.forgeLoopOverrides,
  }
  await removeExistingForgeLoopWorkspaces(opts.client, loopName, opts.directory, {
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

    if (opts.spec.kind === 'plan') {
      const promptText = buildTuiLoopInitialPrompt(opts.spec.text)

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
        return { error: `Failed to send initial loop prompt: ${err instanceof Error ? err.message : String(err)}` }
      }
      debug(`launchTuiLoop: promptAsync ok session=${session.id} workspace=${workspace.id}`)
    }

    await opts.onLaunched?.(session.id, workspace.id)

    await opts.client.workspace.syncList().catch(() => undefined)

    // Local launches wait for the attach hook to acknowledge the loop row in
    // the shared forge database before reporting success, so a workspace that
    // never attaches (filtered session.created, attach failure, etc.) surfaces
    // an error to the launcher instead of appearing silently launched. The
    // remote path cannot observe the remote database, so it skips this gate.
    if (opts.awaitAttachAck && opts.projectId && opts.dbPath) {
      const ack = await waitForLoopRowAcknowledgement({
        projectId: opts.projectId,
        loopName,
        dbPath: opts.dbPath,
        timeoutMs: opts.awaitAttachAckTimeoutMs,
        pollIntervalMs: opts.awaitAttachAckPollIntervalMs,
        debug,
      })
      if (!ack.ok) {
        debug(`launchTuiLoop: attach acknowledgement not observed loop=${loopName} reason=${ack.reason}`)
        return { error: `Loop launch not confirmed by the server attach path: ${ack.reason}` }
      }
    }

    return {
      sessionId: session.id,
      loopName,
      worktreeDir: workspace.directory ?? undefined,
      workspaceId: workspace.id,
    }
  } catch (err) {
    debug(`launchTuiLoop: post-create flow failed error=${err instanceof Error ? err.message : String(err)}`)
    return { error: `Loop launch failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * Idempotent local-launch acknowledgement: polls the shared forge database for
 * the loop row the attach hook writes once it has wired the session into the
 * loop runtime. Resolves once the row exists in a non-terminal status, or once
 * the timeout elapses. Used by {@link launchTuiLoop} when the launcher opts in
 * via `awaitAttachAck`. Remote launches cannot observe the remote database
 * through this surface and therefore do not call it.
 */
async function waitForLoopRowAcknowledgement(input: {
  projectId: string
  loopName: string
  dbPath: string
  timeoutMs?: number
  pollIntervalMs?: number
  debug: (message: string) => void
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Env overrides mirror the `FORGE_TUI_WORKSPACE_SETTLE_MS` pattern so tests
  // can shrink the wait without adding launch-surface option plumbing.
  const envTimeout = Number(process.env.FORGE_TUI_ATTACH_ACK_TIMEOUT_MS)
  const envPoll = Number(process.env.FORGE_TUI_ATTACH_ACK_POLL_MS)
  const timeoutMs = input.timeoutMs
    ?? (Number.isFinite(envTimeout) && envTimeout >= 0 ? envTimeout : 10_000)
  const pollIntervalMs = input.pollIntervalMs
    ?? (Number.isFinite(envPoll) && envPoll >= 0 ? envPoll : 100)
  const deadline = Date.now() + timeoutMs
  do {
    const loops = fetchLoopsList(input.projectId, input.dbPath)
    const row = loops.find((l) => l.name === input.loopName)
    if (row) {
      if (row.active) {
        input.debug(`waitForLoopRowAcknowledgement: ok loop=${input.loopName} status=running`)
        return { ok: true }
      }
      // A row that exists but is not running means the attach hook wired the
      // session and then failed/terminated it. Surface that rather than
      // waiting out the timeout; the launcher would otherwise report a
      // success that the server already rolled back.
      input.debug(`waitForLoopRowAcknowledgement: terminal loop=${input.loopName} phase=${row.phase}${row.terminationReason ? ` reason=${row.terminationReason}` : ''}`)
      return { ok: false, reason: row.terminationReason
        ? `loop row not running (${row.phase}: ${row.terminationReason})`
        : `loop row not running (${row.phase})` }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs))
  } while (Date.now() < deadline)
  input.debug(`waitForLoopRowAcknowledgement: timeout loop=${input.loopName}`)
  return { ok: false, reason: `loop row not observed within ${timeoutMs}ms` }
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
  dbPath?: string,
  /**
   * Plugin config used by the local launch path to resolve the loop launch
   * policy and to wait for attach acknowledgement. Tests omit it to preserve
   * the prior "stamp nothing / no acknowledgement" behaviour; production
   * passes the loaded config and opts into attach acknowledgement.
   */
  pluginConfig?: PluginConfig,
  awaitAttachAck?: boolean,
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

      const spec = req.spec
      if (!spec) {
        return { error: 'No plan or goal spec was provided for execution.' }
      }

      if (spec.kind === 'goal' && req.mode !== 'loop') {
        return { error: 'Goal briefs can only run as a Loop' }
      }

      if (req.mode === 'execute-here') {
        const prompt = `The architect agent has created an implementation plan in this conversation above. You are now the code agent taking over this session. Your job is to execute the plan — edit files, run commands, create tests, and implement every phase. Do NOT just describe or summarize the changes. Actually make them.\n\nPlan reference: ${spec.text}`

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
            parts: [{ type: 'text' as const, text: spec.text }],
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
          requestedLoopName: req.loopName ?? (req.title ? sanitizeLoopName(req.title) : extractLaunchSpecMetadata(spec).executionName),
          title: req.title,
          spec,
          executionModel: req.executionModel,
          auditorModel: req.auditorModel,
          executionVariant: req.executionVariant,
          auditorVariant: req.auditorVariant,
          hostSessionId: sessionId || undefined,
          allowDirectories: allowExternalDirectories,
          dbPath,
          pluginConfig,
          awaitAttachAck,
          onLaunched: (sid, wid) => selectTuiSession(api, client, sid, wid),
          debug: tuiDebug,
        })
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
    loadLaunchSpec(sessionId) {
      // Storage is the plan of record for execute-plan and the approval hook, so
      // the dialog must show exactly what would execute. The message scan
      // remains as a fallback for sessions whose marked plan was never captured.
      // `dbPath` honors a configured PluginConfig.dataDir so tool-authored plans
      // stored outside the default data dir still resolve here.
      const stored = projectId ? fetchStoredSessionLaunchSpec(projectId, sessionId, dbPath) : null
      if (stored) return Promise.resolve(stored)
      return fetchLatestPlanForSession(client, sessionId, directory).then((text) =>
        text ? { kind: 'plan', text, updatedAt: 0 } : null,
      )
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
