import type { ExecutionPreferences } from './tui-execution-preferences'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import { appendFileSync, mkdirSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
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
import {
  type ForgeNewSessionBridgeResult,
  getForgeExecutionBridge,
} from '../services/execution-bridge'
import { buildLoopPermissionRuleset } from '../constants/loop'
import { getForgeWorkspaceLoopName, removeExistingForgeLoopWorkspaces, getWorktreeProjectPreconditionError } from '../workspace/forge-worktree'
import { classifyWorkspaceCreateThrow } from '../workspace/workspace-create-error'
import { fetchLoopsList, fetchNewSessionOutcomeByNonce, cancelNewSessionRequestExclusive, type CrossProcessCancellationResult } from './tui-loop-store'
import type { LoopNewSessionOutcomeRow } from '../storage/repos/loop-new-session-outcomes-repo'
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

export async function reserveTuiLoopName(client: ForgeClient, projectId: string | null, baseName: string, dbPathOverride?: string): Promise<string> {
  const names = new Set<string>()
  if (projectId) {
    for (const loop of fetchLoopsList(projectId, dbPathOverride)) {
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

/**
 * Builds the instruction prompt the TUI sends to the host session's code agent
 * to drive the server-side `execute-plan` tool when the in-process bridge is
 * unavailable (TUI running against a separate `opencode serve` process). The
 * agent invokes `execute-plan` with `mode='new-session'`; that tool dispatches
 * `plan.execute.newSession` server-side, creating the audited `worktree:false`
 * goal loop and navigating the TUI to the new session over the bus.
 *
 * The plan text is forwarded inline as the `plan` argument so pasted plans
 * unavailable from the session plan store still reach the server-side handler
 * (`handlePlanNewSession` resolves an `inline` source from the argument).
 */
function buildExecutePlanToolInvocationPrompt(req: ExecutePlanRequest, requestNonce: string): string {
  const argLines: string[] = [
    `mode: "new-session"`,
    `title: ${JSON.stringify(req.title)}`,
    `plan: ${JSON.stringify(req.plan)}`,
    `requestNonce: ${JSON.stringify(requestNonce)}`,
    `crossProcess: true`,
  ]
  if (req.loopName) argLines.push(`loopName: ${JSON.stringify(req.loopName)}`)
  if (req.executionModel) argLines.push(`executionModel: ${JSON.stringify(req.executionModel)}`)
  if (req.auditorModel) argLines.push(`auditorModel: ${JSON.stringify(req.auditorModel)}`)
  if (req.executionVariant) argLines.push(`executionVariant: ${JSON.stringify(req.executionVariant)}`)
  if (req.auditorVariant) argLines.push(`auditorVariant: ${JSON.stringify(req.auditorVariant)}`)
  return [
    'Launch the plan in this session by calling the `execute-plan` tool with `mode="new-session"` and the arguments below.',
    'Pass the `plan` argument verbatim (the inline text below), pass `requestNonce` verbatim unchanged, and pass `crossProcess: true` verbatim — the launching panel correlates confirmation on the nonce and the server rejects a cross-process launch missing either.',
    argLines.map((l) => `- ${l}`).join('\n'),
    'After the tool returns, report its output to the user verbatim. The tool output itself distinguishes an audited goal-loop launch from a one-shot fallback launch, so do not pre-classify the result or describe it yourself — just relay what the tool returned.',
    'Do not edit files or attempt the plan yourself in this session.',
  ].join('\n')
}

function getNewSessionPollIntervalMs(): number {
  const raw = process.env.FORGE_TUI_NEW_SESSION_POLL_MS
  if (!raw) return 400
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 400
}

function getNewSessionTimeoutMs(): number {
  const raw = process.env.FORGE_TUI_NEW_SESSION_TIMEOUT_MS
  if (!raw) return 30_000
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30_000
}

/**
 * Polls the shared Forge SQLite store for the single authoritative
 * `loop_new_session_outcomes` row keyed by THIS launch's `requestNonce`,
 * written by `handlePlanNewSession` after the launch committed (audited:
 * `attachLoopToSession` returned ok; one-shot: session.create + prompt
 * succeeded). Returns the outcome's session id + loop name once it appears, or
 * `null` when the deadline elapses.
 *
 * Why a dedicated signal rather than the loop row: `attachLoopToSession`
 * writes the provisional loop row BEFORE sending the initial prompt (so the
 * runtime indexes, watchdog, and hook handlers can attribute the session) and
 * deletes it again on prompt failure. A separate TUI process polling the
 * store could mistake the provisional row for success and observe it disappear
 * shortly after, reporting a false positive. The outcome row is written ONLY
 * after the launch committed — for BOTH audited and one-shot paths — so the
 * resolver can prove the launch fully completed and will not be rolled back.
 *
 * Why a per-launch nonce rather than the predicted session title: the one-shot
 * fallback stamps no host-attribution field the panel can read, so prior
 * versions correlated the fallback by its predicted title. An unrelated
 * concurrent session sharing that title would then be misattributed to this
 * request. The nonce (threaded through the `execute-plan` tool arg / bridge
 * into `ForgeExecutionRequestContext.requestId`) is unique per launch, so
 * concurrent launches — even with an identical title — never collide. A
 * host-session match on the outcome row is an additional fence against nonce
 * reuse across host sessions.
 */
export interface HostSessionNewLoopOptions {
  pollIntervalMs?: number
  timeoutMs?: number
  fetchOutcome?: (projectId: string, requestNonce: string) => LoopNewSessionOutcomeRow | null
  /**
   * Invoked once when the resolver deadline elapses before reporting failure,
   * so the panel can arbitrate against the server-side outcome write for the
   * same nonce BEFORE classifying the launch. Defaults to a closure that
   * returns {@link CrossProcessCancellationResult}; the panel MUST NOT report
   * terminal failure unless the result is `'cancelled'`. When the result is
   * `'committed'`, the host invoked the tool just before the deadline and the
   * outcome won arbitration — the resolver re-reads the outcome and reports
   * success instead of a stale timeout failure. When the result is
   * `'unavailable'` (no shared DB) or `'write-failed'` (DB open / transaction
   * threw), the cancellation could not be confirmed, so the resolver throws an
   * explicit uncertain-failure error rather than silently reporting a clean
   * timeout that masks the race.
   */
  markCancelled?: (projectId: string, requestNonce: string, hostSessionId: string) => CrossProcessCancellationResult
  sleep?: (ms: number) => Promise<void>
  debug?: (message: string) => void
}

export interface HostSessionNewLoopResult {
  loopName?: string
  sessionId: string
}

/**
 * Input handed to the cross-process new-session resolver. The TUI mints a
 * fresh `requestNonce` per launch and queues a `promptAsync` on the host
 * session asking its code agent to invoke the server-side `execute-plan` tool
 * (mode='new-session') with that nonce as an argument. The resolver awaits
 * confirmation that the server-side handler actually committed the launch — by
 * observing the `loop_new_session_outcomes` row keyed by `requestNonce` (and
 * attributed to `hostSessionId`) — before returning. Both audited goal-loop
 * and one-shot fallback outcomes write the same row, so a single correlation
 * key covers both paths and no `session.list` title matching is consulted.
 */
export interface CrossProcessNewSessionInput {
  projectId: string | null
  hostSessionId: string
  requestNonce: string
}

export type CrossProcessNewSessionResolver = (
  input: CrossProcessNewSessionInput,
  options: HostSessionNewLoopOptions,
) => Promise<HostSessionNewLoopResult | null>

/**
 * Default cross-process resolver. Polls the shared Forge
 * `loop_new_session_outcomes` store for the single row keyed by this launch's
 * `requestNonce` (the authoritative post-commit signal written by
 * `handlePlanNewSession` for both audited goal loops and the one-shot
 * fallback). Returns the outcome's session id (+ loop name when audited) once
 * it appears and is attributed to our host session. Returns `null` when no
 * matching outcome arrives before the deadline — meaning the host agent
 * ignored the instruction, dropped the nonce, the server-side handler errored,
 * or the polling deadline elapsed — so the panel surfaces an explicit failure
 * rather than reporting success off a queued prompt. No `session.list` polling
 * is consulted: title-only correlation could misattribute an unrelated
 * concurrent same-title session, and the nonce now carries the request
 * identity end-to-end.
 */
async function defaultCrossProcessNewSessionResolver(
  input: CrossProcessNewSessionInput,
  options: HostSessionNewLoopOptions,
): Promise<HostSessionNewLoopResult | null> {
  const { projectId, hostSessionId, requestNonce } = input
  const pollIntervalMs = options.pollIntervalMs ?? getNewSessionPollIntervalMs()
  const timeoutMs = options.timeoutMs ?? getNewSessionTimeoutMs()
  const fetchOutcome = options.fetchOutcome ?? ((pid: string, nonce: string) => fetchNewSessionOutcomeByNonce(pid, nonce))
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const debug = options.debug ?? tuiDebug
  const deadline = Date.now() + timeoutMs

  debug(`cross-process resolver: host=${hostSessionId} nonce=${requestNonce} pollMs=${pollIntervalMs} timeoutMs=${timeoutMs}`)
  while (Date.now() < deadline) {
    try {
      const outcome = projectId ? fetchOutcome(projectId, requestNonce) : null
      if (outcome && outcome.hostSessionId === hostSessionId) {
        debug(`cross-process resolver: observed outcome kind=${outcome.kind} loop=${outcome.loopName ?? 'none'} session=${outcome.outcomeSessionId}`)
        return {
          sessionId: outcome.outcomeSessionId,
          ...(outcome.loopName ? { loopName: outcome.loopName } : {}),
        }
      }
    } catch (err) {
      debug(`cross-process resolver: fetchOutcome failed error=${err instanceof Error ? err.message : String(err)}`)
    }

    if (pollIntervalMs <= 0) break
    await sleep(pollIntervalMs)
  }
  debug(`cross-process resolver: timed out host=${hostSessionId} nonce=${requestNonce}`)
  // Atomic arbitration: the panel and the host invoke separate processes that
  // cannot share memory, so this timeout point is the only place a stale race
  // (the server-side handler committing the launch outcome just before the
  // deadline) would otherwise be misclassified. Calling markCancelled now
  // either commits the cancellation atomically (`'cancelled'` — the delayed
  // host invocation carrying this nonce will be refused at
  // handlePlanNewSession entry; the panel reports a clean terminal failure)
  // or observes that the outcome already committed (`'committed'` — the host
  // invoked the tool just before the deadline; do NOT report a stale timeout
  // failure, re-read the outcome and report the launch as successful). When
  // arbitration cannot confirm cancellation (`'unavailable'` / `'write-failed'`),
  // the panel must not claim terminal failure — throw an explicit
  // uncertain-failure error so the launch verdict is surfaced honestly.
  if (projectId) {
    let result: CrossProcessCancellationResult | undefined
    try {
      result = options.markCancelled ? options.markCancelled(projectId, requestNonce, hostSessionId) : undefined
    } catch (err) {
      debug(`cross-process resolver: markCancelled threw error=${err instanceof Error ? err.message : String(err)}`)
      throw new Error('Cross-process launch verdict unconfirmed: cancellation write failed before arbitration.', { cause: err })
    }
    if (!result) {
      // No arbitration hook supplied (or it returned a falsy value) — fall
      // back to the legacy clean-timeout failure so call sites without a
      // shared store keep their old behavior.
      return null
    }
    if (result.kind === 'cancelled') {
      return null
    }
    if (result.kind === 'committed') {
      // The host won the race just before deadline; re-read the authoritative
      // outcome and report success. If the row is gone (e.g. rolled back by
      // outcome-persistence failure on the server side after we observed
      // 'committed' but before our re-read), treat the launch as failed rather
      // than reporting a misleading success.
      let outcome: LoopNewSessionOutcomeRow | null | undefined
      try {
        outcome = fetchOutcome(projectId, requestNonce)
      } catch (err) {
        debug(`cross-process resolver: post-commit refetch failed error=${err instanceof Error ? err.message : String(err)}`)
      }
      if (outcome && outcome.hostSessionId === hostSessionId) {
        debug(`cross-process resolver: arbitration observed committed race outcome session=${outcome.outcomeSessionId}`)
        return {
          sessionId: outcome.outcomeSessionId,
          ...(outcome.loopName ? { loopName: outcome.loopName } : {}),
        }
      }
      // Outcome vanished between win and refetch — surface an explicit
      // uncertain-failure so the panel never reports success off a row that
      // no longer exists.
      throw new Error('Cross-process launch verdict unconfirmed: outcome won arbitration but is no longer readable.')
    }
    // 'unavailable' or 'write-failed' — cancellation could not be confirmed.
    // Attach the original failure as the cause when present so diagnostics
    // can trace why the write did not commit.
    throw new Error('Cross-process launch verdict unconfirmed: cancellation write did not commit.', { cause: result.kind === 'write-failed' ? result.error : undefined })
  }
  return null
}

let crossProcessNewSessionResolver: CrossProcessNewSessionResolver = defaultCrossProcessNewSessionResolver

/**
 * Test seam: override the cross-process new-session resolver used by the
 * no-bridge `plan.execute new-session` path. Pass `null` to restore the
 * production default. Production never overrides this; tests inject canned
 * outcomes so they can assert authoritative success / failure / ignored /
 * one-shot-fallback behavior without driving a real server plugin.
 */
export function __setCrossProcessNewSessionResolver(fn: CrossProcessNewSessionResolver | null): void {
  crossProcessNewSessionResolver = fn ?? defaultCrossProcessNewSessionResolver
}

/**
 * Test-only export of the production default resolver. Lets focused regression
 * tests assert its pre-dispatch baseline mechanics, name correlation, and
 * fencing against unrelated/concurrent signals without driving a full
 * connectForgeProject integration harness.
 */
export const __defaultCrossProcessNewSessionResolver: CrossProcessNewSessionResolver = defaultCrossProcessNewSessionResolver

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
  /**
   * Shared Forge database path (honoring {@link PluginConfig.dataDir}) used by
   * {@link reserveTuiLoopName} to consult the same store active no-worktree
   * loops are registered in. Without this, audited `worktree:false` goal loops
   * launched from a custom `dataDir` would be invisible to the collision check
   * and a separate worktree loop could reuse the same derived name. Leave
   * undefined to fall back to the default Forge data directory.
   */
  dbPathOverride?: string
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

  const loopName = opts.loopNameReserved
    ? opts.requestedLoopName
    : await reserveTuiLoopName(opts.client, opts.projectId, opts.requestedLoopName, opts.dbPathOverride)
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
      return { error: `Failed to send initial loop prompt: ${err instanceof Error ? err.message : String(err)}` }
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
    return { error: `Loop launch failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * Inspect the TUI's SDK client to determine whether the opencode server it is
 * connected to is reachable via a loopback base URL. The legacy hey-api client
 * carries the configured `baseUrl` (the same value derived from `PluginInput.
 * serverUrl` and reused by the v2 client); reading it through the same
 * private-config seam `createV2ClientFromPluginInput` already uses keeps a
 * single source of truth for the server endpoint.
 *
 * The cross-process `new-session` path uses this to decide whether the Forge
 * default data directory (resolved identically by a co-located TUI and server)
 * can safely substitute for an explicit shared `dataDir`: only a loopback base
 * URL guarantees both processes hit the SAME local filesystem and therefore
 * the SAME default `forge.db`. A non-loopback URL (or one we cannot read) is
 * treated as a remote/non-shared deployment and rejected pre-dispatch.
 */
function opencodeServerBaseUrlIsLoopback(client: unknown): boolean {
  try {
    const legacy = (client as { _client?: { getConfig?: () => { baseUrl?: string } | undefined } | undefined } | undefined)?._client
    const baseUrl = legacy?.getConfig?.()?.baseUrl
    if (!baseUrl) return false
    let host: string
    try {
      host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    } catch {
      return false
    }
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0'
  } catch {
    return false
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
  pluginConfig?: { dataDir?: string } | null,
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

  /**
   * Config-aware shared Forge database path. The server plugin persists loop
   * state, new-session outcomes, and cancellations to `<dataDir>/forge.db`
   * (honoring {@link PluginConfig.dataDir}); the TUI's cross-process resolver
   * must read and write the SAME database, otherwise a deployment with a
   * non-default `dataDir` would silently time out against the default path.
   * Falls back to `undefined` (which makes the accessors use the default
   * Forge data directory) when no override is supplied. Only the cross-process
   * new-session path reads/writes the shared DB, so this is scoped to that
   * resolver invocation below.
   */
  const configuredDataDir = pluginConfig?.dataDir?.trim() || undefined
  const sharedDbPathOverride = configuredDataDir ? join(configuredDataDir, 'forge.db') : undefined
  /**
   * Whether the connected opencode server shares the TUI's local filesystem.
   * The cross-process path proves launch outcomes by reading the shared Forge
   * database; when no explicit `dataDir` is configured, that proof only holds
   * if both processes resolve the SAME default Forge data directory — i.e. the
   * server runs on this machine. A loopback `baseUrl` is the strongest signal
   * we can read from the SDK client; anything else (remote host, or no
   * readable base URL) is treated as a non-shared deployment and rejected
   * pre-dispatch below rather than queuing an unverifiable host instruction.
   */
  const sharedDefaultDbSafe = opencodeServerBaseUrlIsLoopback(api.client)

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
        /**
         * Two transports reach the server-side `handlePlanNewSession` (the single
         * implementation of `plan.execute.newSession`):
         *
         * 1. Co-located fast path — when the server plugin shares this opencode
         *    process (the common interactive deployment), it publishes its
         *    dispatch into the in-process bridge registry below. The bridge
         *    call is synchronous and returns the new loop session id + loop
         *    name so the panel can navigate immediately.
         *
         * 2. Cross-process path — when the TUI runs against a separate
         *    `opencode serve` process (no bridge registered in this realm),
         *    route through the only existing TUI→server RPC the opencode SDK
         *    exposes for arbitrary work: `session.promptAsync`. The host
         *    session's code agent is asked to invoke the `execute-plan` tool
         *    with `mode='new-session'` and the panel's chosen models/variants;
         *    that tool runs in the server plugin and dispatches
         *    `plan.execute.newSession`, which creates the audited
         *    `worktree:false` goal loop and navigates the TUI to the new
         *    session over the bus. This keeps `handlePlanNewSession` as the
         *    sole server-side implementation and reaches it across the real
         *    process boundary instead of erroring.
         *
         * The disabled/global one-shot fallback lives inside
         * `handlePlanNewSession` in both paths.
         */
        const bridge = directory ? getForgeExecutionBridge(directory) : undefined
        const targetSessionId = req.targetSessionId ?? sessionId
        /**
         * Per-launch correlation nonce. The co-located bridge forwards it into
         * the server-side execution context's `requestId`; the cross-process
         * path forwards it as the `requestNonce` argument of the
         * `execute-plan` tool invocation. Either way `handlePlanNewSession`
         * records the authoritative `loop_new_session_outcomes` row keyed by
         * this nonce after the launch commits (audited attach ok OR one-shot
         * session created + prompted). The cross-process resolver then polls
         * that single row by nonce + host session, never by session title — so
         * an unrelated concurrent same-title session cannot be misattributed to
         * this launch.
         */
        const requestNonce = randomUUID()
        if (bridge) {
          const bridgeResult: ForgeNewSessionBridgeResult = await bridge({
            directory: directory ?? '',
            sourceSessionId: sessionId || undefined,
            title: req.title,
            loopName: req.loopName,
            planText: req.plan,
            executionModel: req.executionModel,
            auditorModel: req.auditorModel,
            executionVariant: req.executionVariant,
            auditorVariant: req.auditorVariant,
            requestNonce,
            // Mirror the execute-plan tool's session-cleanup lifecycle so a
            // failed bridge launch (prompt failure inside handlePlanNewSession
            // / launchOneShotNewSession) deletes the orphan session it
            // created, instead of leaving a dangling created session paired
            // with a panel failure. Session selection stays on the panel side
            // (the panel routes the user via api.route.navigate), so this does
            // not set `selectSession` or `returnToSourceOnPromptFailure`.
            lifecycle: {
              deleteSessionOnPromptFailure: true,
            },
          })
          if (!bridgeResult.ok) {
            return { error: bridgeResult.message }
          }
          return { sessionId: bridgeResult.sessionId, loopName: bridgeResult.loopName }
        }
        // Cross-process gate (no in-process bridge): the panel must observe the
        // server-side handler's committed outcome by polling the shared Forge
        // database. Two preconditions must hold BEFORE we queue a host
        // instruction, or the panel can phantom-fail while the server still
        // launches, and cannot fence against retries:
        //
        //   1. A resolved Forge project scope (`projectId`) — the
        //      (project_id, request_nonce) lookup keys need it.
        //   2. A shared Forge database the TUI can demonstrably read.
        //
        // An explicit `dataDir` resolves a single path both processes honor;
        // when its `<dataDir>/forge.db` is locally reachable, the panel can
        // authoritatively confirm AND cancel against the same store. Without
        // an explicit `dataDir` the default Forge data directory is used. The
        // default resolves to a per-machine location, so it is shared ONLY when
        // the connected opencode server runs on this same host (loopback base
        // URL). On a loopback deployment we permit the default DB; on a remote
        // or unreadable endpoint `existsSync` cannot distinguish "co-located
        // shared" from "remote separate" (a separate-machine TUI would read its
        // OWN local forge.db, always present, instead of the server's). So a
        // no-bridge, no-explicit-dataDir, non-loopback deployment is rejected
        // BEFORE dispatch rather than queuing a request whose outcome the panel
        // could never confirm.
        if (!projectId) {
          tuiDebug('cross-process new-session: refusing to dispatch — Forge project scope unresolved')
          return { error: 'Cannot launch a new session cross-process without a resolved Forge project scope. Restart opencode in this directory and retry, or run via a connected bridge deployment.' }
        }
        if (configuredDataDir) {
          const sharedDbPath = join(configuredDataDir, 'forge.db')
          if (!existsSync(sharedDbPath)) {
            tuiDebug(`cross-process new-session: refusing to dispatch — shared Forge database not reachable at ${sharedDbPath}`)
            return { error: `Cross-process launch cannot be confirmed: the configured Forge database at ${sharedDbPath} is not reachable from this TUI process. Run on the same machine/container as the server, or relaunch via the in-process bridge deployment.` }
          }
        } else if (sharedDefaultDbSafe) {
          tuiDebug('cross-process new-session: dispatching against the default Forge database — connected opencode server is loopback (same host)')
        } else {
          tuiDebug('cross-process new-session: refusing to dispatch — no explicit Forge dataDir and the connected opencode server is not loopback; the default Forge database cannot be guaranteed shared between TUI and server')
          return { error: 'Cross-process launch cannot be confirmed: no Forge dataDir is configured and the connected opencode server is not on this host, so the default Forge database may not be shared between this TUI process and the server (e.g. across separate machines/containers). Configure forge.dataDir to a path both processes can read, or run via the in-process bridge deployment.' }
        }
        const instruction = buildExecutePlanToolInvocationPrompt(req, requestNonce)
        const modelVariant = buildPromptModelSelection(parsedModel, req.executionVariant)

        let promptError: unknown
        try {
          await client.session.promptAsync({
            sessionID: targetSessionId,
            directory,
            agent: 'code',
            ...modelVariant,
            parts: [{ type: 'text' as const, text: instruction }],
          })
        } catch (err) {
          promptError = err
        }

        if (promptError) {
          // A thrown `promptAsync` does NOT prove the host invocation was
          // never accepted: the request can be queued on the server side
          // before the response is lost (network reset, process kill, etc.).
          // Returning a clean `null` here would let the panel report failure
          // while a delayed host invocation still launches a real loop — and
          // the user's retry with a fresh nonce would then create a duplicate.
          //
          // Arbitrate against the shared `loop_new_session_outcomes` store
          // using the same nonce + host session the resolver uses on timeout:
          //   - 'cancelled'   -> the launch has not committed; the cancellation
          //                      marker now fences off a delayed host invocation
          //                      at handlePlanNewSession entry, so a clean
          //                      terminal failure is safe.
          //   - 'committed'   -> the host invocation won arbitration just before
          //                      the response was lost; the launch DID commit.
          //                      Re-read the outcome row and report success so
          //                      the user does not retry against an already-
          //                      running loop.
          //   - 'unavailable' / 'write-failed' -> cancellation could not be
          //                      confirmed; surface an explicit uncertain
          //                      failure so the panel never masks the race.
          tuiDebug(`execute-plan cross-process: promptAsync threw, arbitrating nonce=${requestNonce} err=${promptError instanceof Error ? promptError.message : String(promptError)}`)
          const arbitration = cancelNewSessionRequestExclusive(projectId, requestNonce, targetSessionId || '', sharedDbPathOverride)
          if (arbitration.kind === 'committed') {
            const outcome = fetchNewSessionOutcomeByNonce(projectId, requestNonce, sharedDbPathOverride)
            if (outcome && outcome.hostSessionId === targetSessionId) {
              tuiDebug(`execute-plan cross-process: promptAsync threw but outcome already committed session=${outcome.outcomeSessionId}`)
              return { sessionId: outcome.outcomeSessionId, ...(outcome.loopName ? { loopName: outcome.loopName } : {}) }
            }
            throw new Error('Cross-process launch verdict unconfirmed: promptAsync failed, outcome won arbitration but is no longer readable.', { cause: promptError })
          }
          if (arbitration.kind === 'cancelled') {
            tuiDebug(`execute-plan cross-process: promptAsync failed, cancellation committed; reporting terminal failure`)
            return null
          }
          throw new Error('Cross-process launch verdict unconfirmed: promptAsync failed and cancellation write did not commit.', {
            cause: arbitration.kind === 'write-failed' ? arbitration.error : promptError,
          })
        }
        /**
         * Cross-process path: await authoritative confirmation from the
         * server-side `plan.execute.newSession` handler before reporting
         * success. The resolver polls the shared Forge
         * `loop_new_session_outcomes` store for the single row keyed by this
         * launch's `requestNonce` (and attributed to our host session) —
         * written ONLY after the launch committed, for both audited goal loops
         * and the one-shot fallback. If no matching outcome arrives before the
         * deadline, the host agent ignored/dropped the nonce or the handler
         * failed, so the panel surfaces an explicit failure rather than
         * reporting success off the queued `promptAsync`. Using the per-launch
         * nonce (instead of the provisional loop row the handler writes before
         * the prompt, or the predicted session title) prevents a slow prompt
         * failure or an unrelated concurrent same-title session from producing
         * a false success.
         *
         * The resolver is a swappable seam (`__setCrossProcessNewSessionResolver`)
         * so the cross-process scenarios — handler success, handler failure,
         * ignored tool invocation, one-shot fallback, and the slow-failure
         * race — can be exercised without a real server plugin in flight.
         */
        const result = await crossProcessNewSessionResolver(
          {
            projectId,
            hostSessionId: targetSessionId || '',
            requestNonce,
          },
          {
            pollIntervalMs: getNewSessionPollIntervalMs(),
            timeoutMs: getNewSessionTimeoutMs(),
            debug: tuiDebug,
            // Read the shared outcome store via the configured/shared DB path
            // (honors PluginConfig.dataDir) so a non-default data dir still
            // resolves cross-process launches. On timeout, write the
            // authoritative cancellation marker into the same store so a
            // delayed host invocation carrying this nonce is refused by
            // handlePlanNewSession at entry — preventing a duplicate launch
            // after the user has already seen a failure and retried.
            fetchOutcome: (pid, nonce) => fetchNewSessionOutcomeByNonce(pid, nonce, sharedDbPathOverride),
            markCancelled: (pid, nonce, host) => cancelNewSessionRequestExclusive(pid, nonce, host, sharedDbPathOverride),
          },
        )
        if (result) {
          tuiDebug(`execute-plan cross-process: loop=${result.loopName ?? 'none'} session=${result.sessionId}`)
          return { sessionId: result.sessionId, ...(result.loopName ? { loopName: result.loopName } : {}) }
        }
        tuiDebug(`execute-plan cross-process: polling timed out host=${targetSessionId} nonce=${requestNonce}`)
        return null
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
          // Honor the configured shared DB so the loop-name reservation check
          // sees active no-worktree loops registered against a custom dataDir,
          // and does not silently reuse their derived names for a worktree loop.
          dbPathOverride: sharedDbPathOverride,
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
