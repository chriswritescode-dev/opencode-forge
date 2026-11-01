import type { ForgeClient, ForgeEvent, SessionGetParams } from '../client/port'
import { ForgeClientError } from '../client/port'
import { buildAgents } from '../agents'
import { createConfigHandler } from '../config'
import { createSessionHooks, createLoopEventHandler } from '../hooks'
import { initializeDatabase, resolveOpencodeToolOutputDir, closeDatabase, createLoopsRepo, createPlansRepo, createReviewFindingsRepo, createSectionPlansRepo, createLoopSessionUsageRepo, createLoopTransitionsRepo, createPlanAmendmentsRepo, createLoopAttemptsRepo, createSessionSandboxPreferencesRepo, createSessionAutoApproveRepo, createGoalsRepo } from '../storage'
import type { LoopChangeNotifier } from '../loop'
import { resolveBundledContainerDir, resolvePromptsDir } from '../setup'
import { resolveLogPath } from '../storage'
import { createLogger, slugify } from '../utils/logger'
import { createMsbRuntime, describeMsbUnavailable } from '../sandbox/msb'
import { collectLegacySandboxConfigWarnings } from '../sandbox/config-warnings'
import { defaultGitService } from '../utils/git-service'
import { resolveSandboxContextForLoop, isSandboxConfigEnabled, isSandboxEnabled, resolveSandboxMountConfigs, type SandboxContext } from '../sandbox/context'
import { readLoopSandboxSettings, readSandboxOverrides, resolveSandboxAllowLan, resolveSandboxResources } from '../sandbox/loop-settings'
import { createEnvironmentProbe } from '../sandbox/env-probe'
import { resolveOpencodeTmpDir, resolveForgeDataDir } from '../utils/opencode-paths'
import { isForgeWorktreeDir, forgeWorktreesRoot } from '../workspace/forge-naming'
import { MAX_TOTAL_SECTIONS } from '../constants/loop'
import { resolveLoopPermissionOptionsForWorkspace } from '../utils/loop-permission-options'
import { emitLoopPermissionConfigWarnings, emitLoopSessionReuseConfigWarnings } from '../utils/loop-permission-warnings'
import { publishToast } from '../utils/toast'
import { createSandboxManager } from '../sandbox/manager'
import { DEFAULT_SANDBOX_IMAGE, formatTemplateBuildCommands } from '../sandbox/template'
import { createSessionSandboxController, createUnavailableSandboxLifecycleManager, deriveManagerKey, type ResolveActiveLoopForSession, type SessionSandboxController } from '../sandbox/session-controller'
import type { PluginConfig, CompactionConfig, AutoApproveDenyRule, Logger } from '../types'
import { parseAutoApproveDenyRules } from '../utils/auto-approve-policy'
import { createTools } from '../tools'
import { createToolExecuteBeforeHook, createToolExecuteAfterHook, createPlanApprovalEventHook } from '../hooks'
import { createSandboxToolBeforeHook, createSandboxToolAfterHook } from '../hooks/sandbox-tools'
import type { ToolAfterInput, ToolAfterOutput, ToolBeforeInput, ToolBeforeOutput } from '../hooks/tool-hook-types'
import type { ToolDefinition } from '../tools/tool'
import type { ForgeWorkspaceAdapter } from '../workspace/forge-adapter'
import { ensureShellShim } from '../sandbox/shell-shim'
import type { ToolContext } from '../tools'

import { LRUCache } from '../utils/lru-cache'
import { ParentLookupUndeterminedError } from '../utils/session-ancestry'
import { resolveSessionAutoApproveFlag } from '../utils/session-auto-approve-flag'
import { createSessionLoopResolver } from '../services/session-loop-resolver'
import { createUnifiedSandboxResolver } from '../services/unified-sandbox-resolver'
import { createPlanCaptureEventHook } from '../hooks/plan-capture'
import { createGoalPlannerEventHook } from '../hooks/goal-orchestrator'
import { createForgeSessionAttachHook, createForgeSessionMessageAttachHook } from '../hooks/forge-session-attach'
import { createLoopPermissionPatcher } from '../hooks/loop-permission'
import { createSandboxMessageHook } from '../hooks/sandbox-message'
import { buildStartLoopCommand, createForgeExecutionService, type ForgeExecutionRequestContext, type PlanSource } from '../services/execution'
import { createArchitectAutoPlanner } from '../services/architect-auto-planner'
import { createGoalOrchestrator, acquireGoalOrchestratorDb, type GoalOrchestrator } from '../services/goal-orchestrator'
import { deleteSessionBestEffort } from '../utils/loop-session'
import type { ForgeExecutePlanInput, ForgeExecutePlanOutput, ForgeAutoApproveState, ForgeLoopDefaults, ForgeTuiEvent } from './forge-rpc'
import { createTuiRpcService, type TuiRpcService } from '../services/tui-rpc-service'
import { processShared } from '../utils/process-shared'
import { emitTuiEvent, registerTuiEventEmitter } from './tui-events'
import { errorMessage } from '../utils/error-message'

/**
 * Host-supplied inputs the core needs to run, built by the host adapter from its plugin
 * context so the core never touches a host-specific type.
 */
export interface ForgeHostInput {
  directory: string
  projectId: string
  projectRoot: string
  client: ForgeClient
  registerWorkspaceAdapter: (adapter: ForgeWorkspaceAdapter) => void
  /**
   * Host push channel for TUI refresh events. Fire-and-forget: it must never
   * throw into the core, and a failed publish is the host's to log.
   */
  publishTuiEvent?: (event: ForgeTuiEvent) => void
}

/**
 * Host-neutral core of the Forge plugin: every handler the host adapter maps onto its own
 * hook surface, so routing, permissions, and sandbox resolution live in one implementation.
 */
export interface ForgeCore {
  tools: Record<string, ToolDefinition>
  applyConfig(cfg: Record<string, unknown>): Promise<void>
  chatMessage(input: { sessionID: string; messageID?: string; agent?: string }, output: unknown): Promise<void>
  systemTransform(input: { sessionID?: string }, output: { system: string[] }): Promise<void>
  onEvent(input: { event: ForgeEvent }): Promise<void>
  toolBefore(input: ToolBeforeInput, output: ToolBeforeOutput): Promise<void>
  toolAfter(input: ToolAfterInput, output: ToolAfterOutput): Promise<void>
  compacting(input: { sessionID: string }, output: { context: string[]; prompt?: string }): Promise<void>
  architectReminderFor(agent: string | undefined): string | null
  /** Prompt appended after OpenCode's default system prompt for the named Forge agent, or null. */
  systemAddendumFor(agent: string | undefined): string | null
  executeTuiPlan(input: ForgeExecutePlanInput): Promise<ForgeExecutePlanOutput>
  /** Server-side loop-setting defaults the execution dialog shows before a loop is launched. */
  loopDefaults(): ForgeLoopDefaults
  resolveSandboxForDirectory(directory: string, opts?: { throwOnRestoreError?: boolean }): Promise<SandboxContext | null>
  /**
   * Sandbox for a shell tool call in `sessionID`, or null to run it on the host. Returns null
   * without any session lookup while no loop is active and no host session sandbox is on.
   * Fails closed: throws when an expected sandbox cannot be resolved or restored.
   */
  resolveShellSandbox(sessionID: string): Promise<SandboxContext | null>
  /**
   * True when a permission prompt in `sessionID` should be approved automatically: the session has an
   * enabled per-session auto-approve flag (its own or an ancestor's) and is not inside an active loop,
   * or the session's shell calls run in a sandbox and `sandbox.autoApprovePermissions` is not disabled.
   * Any resolution failure answers false so the prompt is still shown.
   */
  autoApprovesPermissions(sessionID: string): Promise<boolean>
  /**
   * True when `sessionID` is the planner session of a goal chunk that is still planning while its goal
   * is running — the planner runs unattended, so a request that would ask is denied instead of waiting.
   * A planner session kept for inspection after its goal paused answers false so its prompts are shown.
   * A lookup failure answers false.
   */
  isUnattendedGoalPlannerSession(sessionID: string): boolean
  /** Resolves whether per-session auto-approve is on for `sessionID`, whether that is inherited, and the session that owns the flag. */
  getSessionAutoApproveState(sessionID: string): Promise<ForgeAutoApproveState>
  /**
   * Turns per-session auto-approve on or off for `sessionID`. Refuses to toggle a flag inherited from
   * an ancestor, and refuses to enable it inside an active loop. Resolves to the resulting state, or
   * an error when the toggle could not be applied.
   */
  setSessionAutoApprove(sessionID: string, enabled: boolean): Promise<ForgeAutoApproveState>
  /** Extra deny rules applied while auto-approve is on, from `autoApprove.deny`. */
  autoApproveDenyRules: ReadonlyArray<AutoApproveDenyRule>
  /** Read and control surface the TUI reaches through the FORGE_RPC plugin RPC. */
  tui: TuiRpcService
  cleanup(): Promise<void>
  shellShimPath: string | null
}

export interface CreateParentSessionLookupOptions {
  client: ForgeClient
  directory: string
  loop: import('../loop').Loop
  logger: ReturnType<typeof createLogger>
}

type SessionLookupAttempt = { label: string; directory?: string; input: Record<string, unknown> }

function buildSessionLookupAttempts(
  sessionId: string,
  directory: string,
  loop: import('../loop').Loop,
): SessionLookupAttempt[] {
  const attempts: SessionLookupAttempt[] = []
  const seenDirectories = new Set<string>()
  for (const state of loop.listActive()) {
    if (!state.worktreeDir || seenDirectories.has(state.worktreeDir)) continue
    seenDirectories.add(state.worktreeDir)
    const workspaceParam = state.workspaceId ? { workspace: state.workspaceId } : {}
    attempts.push({
      label: `loop:${state.loopName}`,
      directory: state.worktreeDir,
      input: { sessionID: sessionId, directory: state.worktreeDir, ...workspaceParam },
    })
    if (state.workspaceId) {
      attempts.push({
        label: `loop-ws:${state.loopName}`,
        input: { sessionID: sessionId, workspace: state.workspaceId },
      })
    }
  }
  if (!seenDirectories.has(directory)) {
    attempts.push({ label: 'host', directory, input: { sessionID: sessionId, directory } })
  }
  return attempts
}

export function createParentSessionLookup({
  client,
  directory,
  loop,
  logger,
}: CreateParentSessionLookupOptions): (sessionId: string) => Promise<string | null> {
  const cache = new LRUCache<string | null>(500)

  return async (sessionId: string): Promise<string | null> => {
    if (cache.has(sessionId)) {
      return cache.get(sessionId) ?? null
    }

    const attempts = buildSessionLookupAttempts(sessionId, directory, loop)

    const failures: string[] = []

    for (const attempt of attempts) {
      try {
        const session = await client.session.get(attempt.input as SessionGetParams)
        if (session) {
          const parentId = session.parentID ?? null
          cache.set(sessionId, parentId)
          return parentId
        }
        failures.push(`${attempt.label}[${attempt.directory ?? 'none'}]:empty`)
      } catch (err) {
        // A not-found on one attempt is not absence: a later attempt (another worktree) may still
        // resolve the session, so only this attempt is recorded. Every other failure
        // (connection/unavailable/request) propagates immediately.
        if (err instanceof ForgeClientError && err.kind === 'not-found') {
          failures.push(`${attempt.label}[${attempt.directory ?? 'none'}]:not-found`)
          continue
        }
        throw err
      }
    }

    // Exhausting every attempt means the parent is unknown, not absent. Returning null here would
    // read as "no parent" and let a sandboxed session's sub-agent run on the host; throwing makes
    // routing fail closed. Deliberately not cached: like any other lookup failure it must be
    // retried, so a session that becomes readable resolves on the very next call.
    const detail = failures.join('; ')
    logger.log(`[session-resolver] session.get failed for ${sessionId} across ${attempts.length} attempts: ${detail}`)
    throw new ParentLookupUndeterminedError(sessionId, detail)
  }
}

export interface CreateSessionDirectoryLookupOptions {
  client: ForgeClient
  directory: string
  loop: import('../loop').Loop
  negativeTtlMs?: number
}

interface SessionSandboxIdentity {
  projectId: string
  directory: string
}

const SESSION_IDENTITY_NEGATIVE_TTL_MS = 15000

function createSessionIdentityLookup({
  client,
  directory,
  loop,
  negativeTtlMs = SESSION_IDENTITY_NEGATIVE_TTL_MS,
}: CreateSessionDirectoryLookupOptions, requireProjectId = true): (sessionId: string) => Promise<SessionSandboxIdentity | null> {
  const cache = new LRUCache<SessionSandboxIdentity>(500)
  const negativeCache = new LRUCache<number>(500)

  return async (sessionId: string): Promise<SessionSandboxIdentity | null> => {
    if (cache.has(sessionId)) {
      return cache.get(sessionId) ?? null
    }

    const negExpiry = negativeCache.get(sessionId)
    if (negExpiry !== undefined) {
      if (negExpiry > Date.now()) return null
      negativeCache.delete(sessionId)
    }

    const attempts = buildSessionLookupAttempts(sessionId, directory, loop)
    for (const attempt of attempts) {
      try {
        const session = await client.session.get(attempt.input as SessionGetParams)
        if (session?.directory && (!requireProjectId || session.projectID)) {
          const identity = { projectId: session.projectID ?? '', directory: session.directory }
          negativeCache.delete(sessionId)
          cache.set(sessionId, identity)
          return identity
        }
      } catch {
        // fall through to next attempt
      }
    }

    negativeCache.set(sessionId, Date.now() + negativeTtlMs)
    return null
  }
}

export function createSessionDirectoryLookup(
  options: CreateSessionDirectoryLookupOptions,
): (sessionId: string) => Promise<string | null> {
  const lookup = createSessionIdentityLookup(options, false)
  return async (sessionId) => (await lookup(sessionId))?.directory ?? null
}

export function buildArchitectReminder(): string {
  return `<system-reminder>
READ-ONLY filesystem mode: search and analyze only; plan-write and plan-edit may update plan storage.
Before designing, settle the route with grouped \`question\` rounds after research until every route decision is settled. Finalize the complete stored plan with at most ${MAX_TOTAL_SECTIONS} phases and fix every structure-report warning, then summarize the plan in chat and stop. Once the plan is stored, do not call the \`question\` tool and do not launch anything — the user decides whether and how to execute.
</system-reminder>`
}

/** Inputs the loop-change notifier needs, injected so its settled dispatch is testable. */
export interface LoopChangeNotifierDeps {
  directory: string
  projectId: string
  publishLoopsChanged: () => void
  getGoalOrchestrator: () => GoalOrchestrator | undefined
  logger: Logger
}

/**
 * Builds the loop-change notifier. A settled loop has committed its branch, so
 * the goal orchestrator is asked to advance the goal; the call is fire-and-forget
 * because the orchestrator guards against loops that belong to no goal.
 */
export function createLoopChangeNotifier(deps: LoopChangeNotifierDeps): LoopChangeNotifier {
  const { directory, projectId, publishLoopsChanged, getGoalOrchestrator, logger } = deps

  return (reason, loopName, hint) => {
    const targetDirectories = Array.from(new Set([
      hint?.projectDir,
      hint?.worktreeDir,
      directory,
    ].filter((dir): dir is string => !!dir)))
    logger.debug(`[notifyLoopChange] reason=${reason} loop=${loopName} dirs=${targetDirectories.join(',')} projectId=${projectId}`)

    if (reason === 'settled') {
      getGoalOrchestrator()?.onLoopSettled(loopName).catch((err: unknown) => {
        logger.error(`[notifyLoopChange] goalOrchestrator.onLoopSettled failed for loop=${loopName}:`, err as Error)
      })
    }

    publishLoopsChanged()
  }
}

type SessionSandboxProvider = {
  worktree: boolean
  getParentSessionId: (sessionId: string) => Promise<string | null>
  getSessionDirectory: (sessionId: string) => Promise<string | null>
  getSessionIdentity: (sessionId: string) => Promise<SessionSandboxIdentity | null>
  resolveActiveLoopForSession: ResolveActiveLoopForSession
}

type SharedSessionSandboxController = {
  controller: SessionSandboxController
  started: Promise<void>
  providerState: {
    providers: Set<SessionSandboxProvider>
    current: SessionSandboxProvider
  }
  close: () => void
}

/**
 * One host sandbox controller per project for the whole process: every location's plugin instance
 * has its own module copy, and a second reconciler would race the first on the same container.
 */
const sharedSessionSandboxControllers = processShared('session-sandbox-controllers.v1', () => new Map<string, SharedSessionSandboxController>())

function preferredSessionSandboxProvider(providers: Set<SessionSandboxProvider>): SessionSandboxProvider {
  return [...providers].find((provider) => !provider.worktree) ?? providers.values().next().value!
}

function sessionSandboxProviderForwarding(
  getCurrent: () => SessionSandboxProvider,
): Pick<SessionSandboxProvider, 'getParentSessionId' | 'getSessionDirectory' | 'getSessionIdentity' | 'resolveActiveLoopForSession'> {
  return {
    getParentSessionId: (sessionId) => getCurrent().getParentSessionId(sessionId),
    getSessionDirectory: (sessionId) => getCurrent().getSessionDirectory(sessionId),
    getSessionIdentity: (sessionId) => getCurrent().getSessionIdentity(sessionId),
    resolveActiveLoopForSession: (sessionId) => getCurrent().resolveActiveLoopForSession(sessionId),
  }
}

function acquireSessionSandboxController(
  projectId: string,
  provider: SessionSandboxProvider,
  create: (getCurrent: () => SessionSandboxProvider) => { controller: SessionSandboxController; close: () => void },
): SharedSessionSandboxController {
  const existing = sharedSessionSandboxControllers.get(projectId)
  if (existing) {
    existing.providerState.providers.add(provider)
    existing.providerState.current = preferredSessionSandboxProvider(existing.providerState.providers)
    return existing
  }
  const providerState = {
    providers: new Set([provider]),
    current: provider,
  }
  const { controller, close } = create(() => providerState.current)
  const entry: SharedSessionSandboxController = {
    controller,
    started: controller.start(),
    providerState,
    close,
  }
  sharedSessionSandboxControllers.set(projectId, entry)
  return entry
}

async function releaseSessionSandboxController(
  projectId: string,
  provider: SessionSandboxProvider,
): Promise<void> {
  const entry = sharedSessionSandboxControllers.get(projectId)
  if (!entry || !entry.providerState.providers.has(provider)) return
  if (entry.providerState.providers.size > 1) {
    entry.providerState.providers.delete(provider)
    if (entry.providerState.current === provider) {
      entry.providerState.current = preferredSessionSandboxProvider(entry.providerState.providers)
    }
    return
  }
  sharedSessionSandboxControllers.delete(projectId)
  try {
    await entry.controller.dispose()
  } finally {
    entry.close()
    entry.providerState.providers.clear()
  }
}

export async function createForgeCore(config: PluginConfig, host: ForgeHostInput): Promise<ForgeCore> {
  const { directory, projectId, projectRoot, client: forgeClient } = host

  const loggingConfig = config.logging
  const logger = createLogger({
    enabled: loggingConfig?.enabled ?? false,
    file: loggingConfig?.file ?? resolveLogPath(),
    debug: loggingConfig?.debug ?? false,
  })
  logger.log(`Initializing plugin for directory: ${directory}, projectId: ${projectId}`)

  const dataDir = resolveForgeDataDir(config.dataDir)

  // Live TUI emitter for this instance. The host sandbox controller is process-shared and may
  // outlive its creator, so it emits through the registry rather than a captured reference.
  const unregisterTuiEventEmitter = host.publishTuiEvent
    ? registerTuiEventEmitter(projectId, host.publishTuiEvent)
    : null

  // Bursts of loop-row writes (phase rotation, section advance, error bookkeeping) collapse to a
  // single loopsChanged per microtask so the TUI re-reads once instead of once per write.
  let loopsChangedScheduled = false
  const publishLoopsChanged = (): void => {
    if (loopsChangedScheduled) return
    loopsChangedScheduled = true
    queueMicrotask(() => {
      loopsChangedScheduled = false
      emitTuiEvent(projectId, { type: 'loopsChanged', projectId })
    })
  }

  const legacySandboxWarnings = collectLegacySandboxConfigWarnings(config.sandbox as unknown)
  for (const warning of legacySandboxWarnings) {
    logger.log(warning)
  }
  if (legacySandboxWarnings.length > 0 && !isForgeWorktreeDir(dataDir, directory)) {
    publishToast({
      client: forgeClient,
      directory,
      logger,
      title: 'Forge sandbox config',
      message: legacySandboxWarnings.join(' '),
      variant: 'warning',
      duration: 10_000,
    })
  }

  emitLoopPermissionConfigWarnings(config, dataDir, directory, {
    logger,
    onWarnings: (warnings) => {
      publishToast({
        client: forgeClient,
        directory,
        logger,
        title: 'Forge loop permissions',
        message: warnings.join(' '),
        variant: 'warning',
        duration: 10_000,
      })
    },
  })

  emitLoopSessionReuseConfigWarnings(config, dataDir, directory, {
    logger,
    onWarnings: (warnings) => {
      publishToast({
        client: forgeClient,
        directory,
        logger,
        title: 'Forge loop session reuse',
        message: warnings.join(' '),
        variant: 'warning',
        duration: 10_000,
      })
    },
  })

  const parsedAutoApproveDeny = parseAutoApproveDenyRules(config.autoApprove?.deny)
  for (const warning of parsedAutoApproveDeny.warnings) {
    logger.log(warning)
  }
  if (parsedAutoApproveDeny.warnings.length > 0 && !isForgeWorktreeDir(dataDir, directory)) {
    publishToast({
      client: forgeClient,
      directory,
      logger,
      title: 'Forge auto-approve config',
      message: parsedAutoApproveDeny.warnings.join(' '),
      variant: 'warning',
      duration: 10_000,
    })
  }
  const autoApproveDenyRules: ReadonlyArray<AutoApproveDenyRule> = parsedAutoApproveDeny.rules

  let sandboxManager: ReturnType<typeof createSandboxManager> | null = null
  const runtime = createMsbRuntime(logger)
  const hostSandboxManagerKey = deriveManagerKey(projectId)
  if (!isSandboxConfigEnabled(config)) {
    logger.log('Sandbox disabled via config (sandbox.enabled=false); running in worktree-only mode')
  } else {
    const sandboxMountConfigs = resolveSandboxMountConfigs(config)
    try {
      sandboxManager = createSandboxManager(runtime, {
        image: config.sandbox?.image ?? DEFAULT_SANDBOX_IMAGE,
        toolOutputDir: resolveOpencodeToolOutputDir(),
        tmpDir: resolveOpencodeTmpDir(),
        sourceProjectDir: projectRoot,
        mountProjectReadonly: config.sandbox?.mountProjectReadonly,
        ...(sandboxMountConfigs.length > 0 ? { customMounts: sandboxMountConfigs } : {}),
        ...(config.sandbox?.network ? { network: config.sandbox.network } : {}),
        buildContextDir: resolveBundledContainerDir(),
        ...(config.sandbox?.resources ? { resources: config.sandbox.resources } : {}),
        resolveOverrides: (worktreeName) => worktreeName === hostSandboxManagerKey
          ? sandboxPreferences.getDesired(projectId)?.overrides
          : readSandboxOverrides(loopsRepo.get(projectId, worktreeName)?.sandboxSettings),
      }, logger, defaultGitService)
      logger.log('Sandbox manager initialized')
    } catch (err) {
      logger.error('Failed to initialize msb sandbox manager; refusing to run worktree-only while sandbox is enabled', err)
      throw err
    }
  }

  // Sandbox shell routing: opencode's native bash tool is pointed at a shim (via the `shell`
  // config key) that routes commands into the loop container when the shell.env hook injects
  // the container name. Without a working shim there is no safe way to route sandbox loop
  // commands, so refuse to start with the sandbox enabled rather than silently executing on
  // the host. The shim is POSIX sh, so Windows hosts (no shim) fail closed too.
  let shellShimPath: string | null = null
  if (sandboxManager) {
    shellShimPath = process.platform === 'win32' ? null : ensureShellShim(dataDir, logger)
    if (!shellShimPath) {
      throw new Error('Sandbox shell shim unavailable on this host; refusing to run worktree-only mode while sandbox is enabled')
    }
  }
  if (sandboxManager && forgeClient) {
    const sandboxImage = config.sandbox?.image ?? DEFAULT_SANDBOX_IMAGE
    const buildContextDir = resolveBundledContainerDir()
    void (async () => {
      try {
        const available = await runtime.checkAvailable()
        if (!available.available) {
          // `unknown` means the probe itself could not answer (a daemon busy with other
          // sandboxes; every worktree loads its own plugin instance, so probes race at startup).
          // That is not evidence of unavailability, and the template probe below would be just as
          // unreliable, so stay quiet instead of raising a false alarm about either.
          if (available.reason !== 'unknown') {
            publishToast({
              client: forgeClient,
              directory,
              logger,
              title: 'Sandbox unavailable',
              message: describeMsbUnavailable(available),
              variant: 'warning',
              duration: 10_000,
            })
          }
          return
        }
        const exists = await runtime.templateExists(sandboxImage)
        if (!exists) {
          logger.log(`Sandbox template "${sandboxImage}" not found — publishing toast`)
          publishToast({
            client: forgeClient,
            directory,
            logger,
            title: 'Sandbox template not found',
            message: `Sandbox template "${sandboxImage}" is missing. Build it from the command palette: "Build sandbox template", or run: ${formatTemplateBuildCommands(buildContextDir, sandboxImage)}`,
            variant: 'warning',
            duration: 10_000,
          })
        }
      } catch (err: unknown) {
        logger.log(`Sandbox image check: ${errorMessage(err)}`)
      }
    })()
  }

  // Pending-teardown registry: caller (loop termination side-effects) writes
  // iteration/reason/doCommit here right before invoking workspace.remove so
  // the forge adapter can build informative commit messages while remaining
  // the single source of truth for teardown behavior.
  const { createPendingTeardownRegistry } = await import('../workspace/pending-teardown')
  const pendingTeardowns = createPendingTeardownRegistry()

  // Register the forge workspace adapter so loop worktrees are created under <dataDir>/worktrees/
  const { createForgeWorkspaceAdapter } = await import('../workspace/forge-adapter')
  host.registerWorkspaceAdapter(createForgeWorkspaceAdapter({
    dataDir,
    logger,
    sandboxManager,
    gitService: defaultGitService,
    getTeardownContext: (loopName) => pendingTeardowns.get(loopName),
    worktreeOpencodeConfig: config.loop?.worktreeOpencodeConfig,
  }))
  logger.log(`Registered forge workspace adapter (worktrees under ${forgeWorktreesRoot(dataDir)})`)

  const db = initializeDatabase(dataDir, { completedLoopTtlMs: config.completedLoopTtlMs })

  const autoApproveRepo = createSessionAutoApproveRepo(db)
  try {
    const purgedAutoApproves = autoApproveRepo.purgeExpired(Date.now())
    if (purgedAutoApproves > 0) {
      logger.log(`Startup: purged ${purgedAutoApproves} expired session auto-approve flag(s)`)
    }
  } catch (err) {
    logger.error('Failed to purge expired session auto-approve flags', err)
  }

  const autoApproveFlagTouchCache = new LRUCache<number>(1000)
  const AUTO_APPROVE_FLAG_TOUCH_INTERVAL_MS = 60 * 60 * 1000
  const touchAutoApproveFlag = (sessionID: string): void => {
    const now = Date.now()
    const lastTouched = autoApproveFlagTouchCache.get(sessionID)
    if (lastTouched !== undefined && now - lastTouched < AUTO_APPROVE_FLAG_TOUCH_INTERVAL_MS) return
    try {
      autoApproveRepo.touch(projectId, sessionID, now)
      autoApproveFlagTouchCache.set(sessionID, now)
    } catch (err) {
      logger.debug(`[auto-approve] touch failed for ${sessionID}: ${errorMessage(err)}`)
    }
  }

  const loopsRepo = createLoopsRepo(db, logger)
  const sandboxPreferences = createSessionSandboxPreferencesRepo(db)
  const plansRepo = createPlansRepo(db)
  const reviewFindingsRepo = createReviewFindingsRepo(db)
  const sectionPlansRepo = createSectionPlansRepo(db)
  const loopSessionUsageRepo = createLoopSessionUsageRepo(db)
  const loopTransitionsRepo = createLoopTransitionsRepo(db)
  const planAmendmentsRepo = createPlanAmendmentsRepo(db)
  const loopAttemptsRepo = createLoopAttemptsRepo(db)
  const goalsRepo = createGoalsRepo(db)

  /**
   * Forward holder — filled once the execution service exists below, so the
   * loop-change notifier can reach the orchestrator without a construction cycle.
   */
  const goalOrchestratorRef: { orchestrator?: GoalOrchestrator } = {}

  const notifyLoopChange = createLoopChangeNotifier({
    directory,
    projectId,
    publishLoopsChanged,
    getGoalOrchestrator: () => goalOrchestratorRef.orchestrator,
    logger,
  })

  const loopHandler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, projectId, forgeClient, logger, () => config, sandboxManager || undefined, dataDir, config.loop, sectionPlansRepo, notifyLoopChange, pendingTeardowns, loopSessionUsageRepo, loopTransitionsRepo, planAmendmentsRepo, directory, defaultGitService, loopAttemptsRepo)

  const promptsDir = resolvePromptsDir()
  const agents = buildAgents(promptsDir, { model: config.executionModel, variant: config.executionVariant })

  const compactionConfig: CompactionConfig | undefined = config.compaction
  const messagesTransformConfig = config.messagesTransform
  const sessionHooks = createSessionHooks(projectId, logger, compactionConfig)

  let cleanupPromise: Promise<void> | null = null

  let sessionSandboxProjectId: string | null = null
  let sessionSandboxProvider: SessionSandboxProvider | null = null

  const cleanup = (): Promise<void> => {
    if (cleanupPromise) {
      return cleanupPromise
    }
    cleanupPromise = (async () => {
      logger.log('Cleaning up plugin resources...')
      
      // Unregister process listeners before async work
      process.removeListener('exit', handleExit)
      process.removeListener('SIGINT', handleSigint)
      process.removeListener('SIGTERM', handleSigterm)
      unregisterTuiEventEmitter?.()

      logger.log('Loop: active loops preserved during plugin cleanup')
      
      loopHandler.clearAllRetryTimeouts()

      // Disposal and DB close must both be exception-safe: a rejected controller disposal (e.g.
      // a failed container removal or acknowledgement persistence) must never prevent the SQLite
      // handle from closing. The error is logged and swallowed so cleanup completes and the
      // idempotent cleanupPromise still resolves.
      try {
        // Release rather than dispose: the controller is shared by every plugin instance in this
        // process for this project, and only the last release may tear it down.
        if (sessionSandboxProjectId && sessionSandboxProvider) {
          await releaseSessionSandboxController(sessionSandboxProjectId, sessionSandboxProvider)
        }
      } catch (err) {
        logger.error('Error during session sandbox controller disposal', err)
      } finally {
        closeDatabase(db)
        logger.log('Plugin cleanup complete')
      }
    })()
    return cleanupPromise
  }

  const handleSigint = cleanup
  const handleSigterm = cleanup
  // The `exit` event fires once the event loop has drained and cannot await asynchronous work,
  // so it must never run the async disposal (container removal, applied-OFF persistence) — that
  // work would be cut off mid-flight. The awaited shutdown runs through the host's
  // location shutdown and the SIGINT/SIGTERM handlers (which keep the process
  // alive while their async cleanup completes). This listener is registered so shutdown
  // bookkeeping is explicit and cleaned up consistently with the other signals.
  const handleExit = () => {}

  process.once('exit', handleExit)
  process.once('SIGINT', handleSigint)
  process.once('SIGTERM', handleSigterm)

  // Sandbox reconciliation interval removed per Phase 2 requirements.
  // Sandbox reconciliation now only occurs for loops started/restarted
  // in the current plugin process, triggered by explicit runtime events.

  // Create forge-session-attach hook for triggering attachLoopToSession on session.created events
  const forgeAttachExecDeps = {
    projectId,
    directory,
    config,
    logger,
    dataDir,
    client: forgeClient,
    plansRepo,
    loopsRepo,
    loopHandler,
    loop: loopHandler.loop,
    sandboxManager,
    sectionPlansRepo,
    reviewFindingsRepo,
    pendingTeardowns,
  }
  const forgeSessionAttachHook = createForgeSessionAttachHook({
    client: forgeClient,
    execDeps: forgeAttachExecDeps,
    projectId,
    directory,
    logger,
  })
  const forgeSessionMessageAttachHook = createForgeSessionMessageAttachHook({
    client: forgeClient,
    execDeps: forgeAttachExecDeps,
    projectId,
    directory,
    logger,
  })

  const parentSessionLookup = createParentSessionLookup({ client: forgeClient, directory, loop: loopHandler.loop, logger })
  loopHandler.loop.setParentSessionLookup(parentSessionLookup)
  loopHandler.loop.superviseOwnedLoops()
  const sessionIdentityLookup = createSessionIdentityLookup({ client: forgeClient, directory, loop: loopHandler.loop })
  const sessionDirectoryLookup = async (sessionId: string) => (await sessionIdentityLookup(sessionId))?.directory ?? null
  const sessionLoopResolver = createSessionLoopResolver({
    loop: loopHandler.loop,
    getParentSessionId: parentSessionLookup,
    getSessionDirectory: sessionDirectoryLookup,
    logger,
  })
  const resolveAutoApproveFlag = async (sessionID: string) => {
    const flag = await resolveSessionAutoApproveFlag({
      sessionID,
      isEnabled: (id) => autoApproveRepo.isEnabled(projectId, id, Date.now()),
      getParentId: parentSessionLookup,
      isInActiveLoop: async (id) => (await sessionLoopResolver.resolveActiveLoopForSession(id)) !== null,
    })
    if (!flag.enabled && flag.error !== undefined) {
      logger.log(`[auto-approve] session flag lookup failed for ${sessionID}: ${errorMessage(flag.error)}`)
    }
    return flag
  }
  const loopPermissionPatcher = createLoopPermissionPatcher({
    client: forgeClient,
    sessionLoopResolver,
    directory,
    logger,
    getPermissionOptions: (workspaceId) => resolveLoopPermissionOptionsForWorkspace(forgeClient, config, workspaceId),
  })
  // Host-session sandbox controller: reconciles the acknowledged host sandbox preference for
  // sessions outside any loop. Always constructed — even when sandbox routing is unavailable
  // (sandbox disabled, manager init failure, or no shell shim) — so a requested ON is
  // acknowledged as OFF-with-error and the selected session is blocked fail-closed instead of
  // silently executing on the host. Its initial reconcile starts in the background; host sandbox
  // resolution waits for it before deciding whether a session may run on the host.
  // Shared per project across every plugin instance in this process: a second reconciler would
  // race this one on the same container. Only the first instance constructs and starts one, and
  // it gets its own database handle so it never depends on that instance's lifetime.
  const hostSessionProvider: SessionSandboxProvider = {
    worktree: isForgeWorktreeDir(dataDir, directory),
    getParentSessionId: parentSessionLookup,
    getSessionDirectory: sessionDirectoryLookup,
    getSessionIdentity: sessionIdentityLookup,
    resolveActiveLoopForSession: sessionLoopResolver.resolveActiveLoopForSession,
  }
  const sharedSessionSandbox = acquireSessionSandboxController(projectId, hostSessionProvider, (getCurrent) => {
    const forwarding = sessionSandboxProviderForwarding(getCurrent)
    const controllerDb = initializeDatabase(dataDir, { completedLoopTtlMs: config.completedLoopTtlMs })
    return {
      close: () => closeDatabase(controllerDb),
      controller: createSessionSandboxController({
        projectId,
        directory: projectRoot,
        preferences: createSessionSandboxPreferencesRepo(controllerDb),
        sandboxManager: sandboxManager ?? createUnavailableSandboxLifecycleManager(runtime),
        getParentSessionId: forwarding.getParentSessionId,
        getSessionDirectory: forwarding.getSessionDirectory,
        getSessionIdentity: forwarding.getSessionIdentity,
        resolveActiveLoopForSession: forwarding.resolveActiveLoopForSession,
        onChange: () => emitTuiEvent(projectId, { type: 'hostSandboxChanged', projectId }),
        logger,
      }),
    }
  })
  sessionSandboxProjectId = projectId
  sessionSandboxProvider = hostSessionProvider
  void sharedSessionSandbox.started.catch((err) => logger.error('Session sandbox controller failed to start', err))

  // Unified, loop-first sandbox resolver. Loop resolution always takes precedence: an active
  // sandbox loop owns its sessions; an active non-sandbox loop forces host (a host preference
  // cannot override loop/worktree behavior); only sessions with no active loop consult the
  // acknowledged host-session sandbox. Callers opt into fail-closed behavior via
  // { throwOnRestoreError: true }.
  const resolveSandboxForSession = createUnifiedSandboxResolver({
    resolveActiveLoopForSession: sessionLoopResolver.resolveActiveLoopForSession,
    resolveLoopSandbox: (resolved, opts) => resolveSandboxContextForLoop(sandboxManager, resolved, logger, opts),
    resolveHostSandbox: async (sessionID, opts) => {
      await sharedSessionSandbox.controller.start()
      return sharedSessionSandbox.controller.resolveSandboxForSession(sessionID, opts)
    },
  })

  // Tells the agent its tool calls run in a container. Driven by the same resolver as bash so
  // the note appears for sandbox loops, their subagents, and host-sandbox sessions alike.
  const sandboxMessageHook = createSandboxMessageHook({
    resolveSandboxForSession: (sessionID, opts) => resolveSandboxForSession(sessionID, opts),
    probe: createEnvironmentProbe(logger),
    logger,
  })

  // Execution service shared by TUI loop restarts and TUI plan execution.
  // Built once and reused (stateless dispatch) so the dependency wiring lives in a single place.
  const executionService = createForgeExecutionService({
    projectId,
    directory,
    config,
    logger,
    dataDir,
    client: forgeClient,
    plansRepo,
    loopsRepo,
    goalsRepo,
    loopHandler,
    loop: loopHandler.loop,
    sandboxManager,
    sectionPlansRepo,
    reviewFindingsRepo,
    loopSessionUsageRepo,
    pendingTeardowns,
  })

  const goalDb = acquireGoalOrchestratorDb(dataDir, config.completedLoopTtlMs)
  const goalGoalsRepo = createGoalsRepo(goalDb)
  const goalPlansRepo = createPlansRepo(goalDb)

  const architectAutoPlanner = createArchitectAutoPlanner({
    client: forgeClient,
    plansRepo: goalPlansRepo,
    projectId,
    logger,
  })

  const orchestrator = createGoalOrchestrator({
    projectId,
    dataDir,
    goalsRepo: goalGoalsRepo,
    planner: architectAutoPlanner,
    git: defaultGitService,
    getLoopState: (loopName) => loopHandler.loop.service.getAnyState(loopName),
    async startLoop(input) {
      const response = await executionService.dispatch(
        { surface: 'tool', projectId, directory: input.projectDir, sourceSessionId: input.plannerSessionId },
        buildStartLoopCommand({
          source: { kind: 'stored', sessionId: input.plannerSessionId },
          hostSessionId: input.hostSessionId,
          baseRef: input.baseRef,
          executionModel: input.executionModel,
          auditorModel: input.auditorModel,
          executionVariant: input.executionVariant,
          auditorVariant: input.auditorVariant,
          maxIterations: input.maxIterations ?? config.loop?.defaultMaxIterations ?? 0,
          sandbox: input.sandbox,
          lifecycle: { startWatchdog: true },
        }),
      )
      if (response.ok) {
        return {
          ok: true,
          loopName: response.data.loopName,
          branch: response.data.worktreeBranch ?? null,
          title: response.data.displayName ?? null,
        }
      }
      return { ok: false, error: response.error.message }
    },
    async cancelLoop(loopName) {
      await executionService.dispatch(
        { surface: 'tool', projectId, directory },
        { type: 'loop.cancel', selector: { kind: 'exact', name: loopName } },
      )
    },
    async deleteSession(sessionId, sessionDirectory) {
      await deleteSessionBestEffort(
        forgeClient,
        { sessionID: sessionId, directory: sessionDirectory },
        logger,
        'goal-orchestrator: failed to delete planner session',
      )
    },
    deletePlanForSession: (sessionId) => {
      goalPlansRepo.deleteForSession(projectId, sessionId)
    },
    async removeCheckout(checkoutProjectDir, checkoutDir) {
      const { cleanupLoopWorktree } = await import('../utils/worktree-cleanup')
      await cleanupLoopWorktree({
        worktreeDir: checkoutDir,
        logPrefix: 'goal-orchestrator',
        logger,
      })
      if (checkoutProjectDir) defaultGitService.worktreePrune(checkoutProjectDir)
    },
    logger,
  })
  goalOrchestratorRef.orchestrator = orchestrator

  const goalPlannerEventHook = createGoalPlannerEventHook({
    orchestrator,
    goalsRepo,
    projectId,
    logger,
  })

  const tui = createTuiRpcService({
    projectId,
    dataDir,
    config,
    loopsRepo,
    plansRepo,
    sandboxPreferences,
    async restartLoop(request) {
      const response = await executionService.dispatch(
        { surface: 'api', projectId, directory: projectRoot },
        {
          type: 'loop.restart',
          selector: { kind: 'exact', name: request.loopName },
          force: request.force ?? true,
          auditorModel: request.auditorModel,
          auditorVariant: request.auditorVariant,
          executionModel: request.executionModel,
          executionVariant: request.executionVariant,
          expectedStartedAt: request.expectedStartedAt,
        },
      )
      return response.ok
        ? { sessionId: response.data.sessionId }
        : { error: response.error.message }
    },
    onHostSandboxChanged: () => emitTuiEvent(projectId, { type: 'hostSandboxChanged', projectId }),
    logger,
  })

  // ── Tool context ──────────────────────────────────────────────────────────
  const ctx: ToolContext = {
    projectId,
    directory,
    config,
    logger,
    db,
    dataDir,
    loopHandler,
    loop: loopHandler.loop,
    client: forgeClient,
    cleanup,
    sandboxManager,
    plansRepo,
    reviewFindingsRepo,
    loopsRepo,
    goalsRepo,
    sectionPlansRepo,
    loopSessionUsageRepo,
    pendingTeardowns,
    goalOrchestrator: orchestrator,
    resolveActiveLoopForSession: sessionLoopResolver.resolveActiveLoopForSession,
  }

  const tools = createTools(ctx)
  const toolExecuteBeforeHook = createToolExecuteBeforeHook(ctx, {
    resolveActiveLoopForSession: sessionLoopResolver.resolveActiveLoopForSession,
  })
  const toolExecuteAfterHook = createToolExecuteAfterHook(ctx, {
    resolveActiveLoopForSession: sessionLoopResolver.resolveActiveLoopForSession,
  })
  const planApprovalEventHook = createPlanApprovalEventHook(ctx)
  const planCaptureEventHook = createPlanCaptureEventHook(ctx)
  const sandboxBeforeHook = createSandboxToolBeforeHook({
    resolveSandboxForSession,
    logger,
  })
  const sandboxAfterHook = createSandboxToolAfterHook({
    resolveSandboxForSession,
    logger,
  })

  const architectReminderFor = (agent: string | undefined): string | null => {
    if (messagesTransformConfig?.enabled === false) return null
    if (agent !== agents.architect.displayName) return null
    return buildArchitectReminder()
  }

  const systemAddendumFor = (agent: string | undefined): string | null => {
    if (!agent) return null
    for (const definition of Object.values(agents)) {
      if (definition.displayName === agent) return definition.systemAddendum ?? null
    }
    return null
  }

  const executeTuiPlan = async (input: ForgeExecutePlanInput): Promise<ForgeExecutePlanOutput> => {
    const execCtx: ForgeExecutionRequestContext = {
      surface: 'tui',
      projectId,
      directory,
      ...(input.sessionId ? { sourceSessionId: input.sessionId } : {}),
    }
    const source: PlanSource = { kind: 'inline', planText: input.plan }
    const executionModel = input.executionModel || undefined
    const executionVariant = input.executionVariant || undefined

    if (input.mode === 'execute-here') {
      if (!input.sessionId) return { error: 'Execute here requires a current session' }
      const response = await executionService.dispatch(execCtx, {
        type: 'plan.execute.here',
        source,
        targetSessionId: input.sessionId,
        title: input.title,
        executionModel,
        executionVariant,
      })
      return response.ok ? { sessionId: response.data.sessionId } : { error: response.error.message }
    }

    if (input.mode === 'new-session') {
      const response = await executionService.dispatch(execCtx, {
        type: 'plan.execute.newSession',
        source,
        title: input.title,
        executionModel,
        executionVariant,
        lifecycle: { deleteSessionOnPromptFailure: true },
      })
      return response.ok ? { sessionId: response.data.sessionId } : { error: response.error.message }
    }

    const response = await executionService.dispatch(execCtx, buildStartLoopCommand({
      source,
      title: input.title,
      loopName: input.loopName?.trim() ? slugify(input.loopName) : undefined,
      branch: input.branch?.trim() || undefined,
      baseRef: input.baseRef?.trim() || undefined,
      maxIterations: input.maxIterations ?? config.loop?.defaultMaxIterations ?? 0,
      executionModel,
      auditorModel: input.auditorModel || undefined,
      executionVariant,
      auditorVariant: input.auditorVariant || undefined,
      hostSessionId: input.sessionId || undefined,
      sandbox: readLoopSandboxSettings(input.sandbox),
      lifecycle: { startWatchdog: true },
    }))
    if (!response.ok) return { error: response.error.message }
    return {
      sessionId: response.data.sessionId,
      loopName: response.data.loopName,
      ...(response.data.worktreeBranch ? { branch: response.data.worktreeBranch } : {}),
      ...(response.data.worktreeDir ? { worktreeDir: response.data.worktreeDir } : {}),
      ...(response.data.workspaceId ? { workspaceId: response.data.workspaceId } : {}),
      ...(response.data.goalId ? { goalId: response.data.goalId } : {}),
    }
  }

  const loopDefaults = (): ForgeLoopDefaults => ({
    maxIterations: config.loop?.defaultMaxIterations ?? 0,
    sandbox: {
      available: isSandboxEnabled(config, sandboxManager),
      resources: resolveSandboxResources(config.sandbox?.resources),
      allowLan: resolveSandboxAllowLan(config.sandbox?.network?.allowLan),
    },
  })

  const resolveSandboxForDirectory = async (
    targetDirectory: string,
    opts?: { throwOnRestoreError?: boolean },
  ): Promise<SandboxContext | null> => {
    const state = loopHandler.loop.service.findActiveByWorktreeDir(targetDirectory)
    if (!state) return null
    return resolveSandboxContextForLoop(sandboxManager, state, logger, opts)
  }

  const resolveShellSandbox = async (sessionID: string): Promise<SandboxContext | null> => {
    if (!shellShimPath) return null
    await sharedSessionSandbox.controller.start()
    if (loopHandler.loop.listActive().length === 0 && sharedSessionSandbox.controller.isIdle()) return null
    return resolveSandboxForSession(sessionID, { throwOnRestoreError: true })
  }

  const getSessionAutoApproveState = async (sessionID: string): Promise<ForgeAutoApproveState> => {
    const flag = await resolveAutoApproveFlag(sessionID)
    if (flag.enabled) {
      return { enabled: true, ownerSessionId: flag.flagOwnerId, inherited: flag.flagOwnerId !== sessionID }
    }
    if (flag.error !== undefined) {
      return { error: `Could not resolve auto-approve state: ${errorMessage(flag.error)}` }
    }
    return { enabled: false, inherited: false }
  }

  const setSessionAutoApprove = async (sessionID: string, enabled: boolean): Promise<ForgeAutoApproveState> => {
    const state = await getSessionAutoApproveState(sessionID)
    if ('error' in state) return state
    if (state.enabled && state.inherited) {
      return { error: `Auto-approve is inherited from parent session ${state.ownerSessionId}; toggle it there` }
    }
    if (enabled) {
      let activeLoop: Awaited<ReturnType<typeof sessionLoopResolver.resolveActiveLoopForSession>>
      try {
        activeLoop = await sessionLoopResolver.resolveActiveLoopForSession(sessionID)
      } catch (err) {
        return { error: `Could not verify that this session is not in a loop: ${errorMessage(err)}` }
      }
      if (activeLoop) return { error: 'Loop sessions already auto-approve everything not denied' }
      try {
        autoApproveRepo.enable(projectId, sessionID, Date.now())
      } catch (err) {
        return { error: `Auto-approve toggle failed: ${errorMessage(err)}` }
      }
    } else {
      try {
        autoApproveRepo.disable(projectId, sessionID)
      } catch (err) {
        return { error: `Auto-approve toggle failed: ${errorMessage(err)}` }
      }
    }
    emitTuiEvent(projectId, { type: 'autoApproveChanged', projectId, sessionId: sessionID })
    return getSessionAutoApproveState(sessionID)
  }

  return {
    tools,
    applyConfig: createConfigHandler(agents, config.agents, promptsDir),
    chatMessage: async (input, output) => {
      touchAutoApproveFlag(input.sessionID)
      await forgeSessionMessageAttachHook(input)
      // Fallback for filtered session.created events: subagent sessions inside
      // loops must carry the loop ruleset before their first LLM step.
      await loopPermissionPatcher.ensurePatched({ sessionID: input.sessionID })
      await sessionHooks.onMessage(input, output)
    },
    systemTransform: async (input, output) => {
      await sandboxMessageHook(input, output)
    },
    onEvent: async (input) => {
      const eventInput = input as { event: { type: string; properties?: Record<string, unknown> } }
      await planCaptureEventHook(eventInput)
      await loopHandler.onEvent(eventInput)
      await goalPlannerEventHook(eventInput)
      await loopPermissionPatcher.onSessionCreated(eventInput)
      await forgeSessionAttachHook(eventInput)
      await sessionHooks.onEvent(eventInput)
      await planApprovalEventHook(eventInput)
    },
    toolBefore: async (input, output) => {
      // Loop bookkeeping (activity recording, permission patching) is best-effort for tool
      // routing: a transient ancestry/session lookup failure must never reject native file and
      // management tools (`read`, `edit`, `write`, ...), which are host-side by design.
      // Sandbox-routed tools (bash/glob/grep) still fail closed through their own resolver
      // calls, so shell + search isolation is not weakened.
      let resolved: Awaited<ReturnType<typeof sessionLoopResolver.resolveActiveLoopForSession>> | null = null
      try {
        resolved = await sessionLoopResolver.resolveActiveLoopForSession(input.sessionID)
      } catch (err) {
        logger.debug(`[tool-before] loop resolution failed for session ${input.sessionID}: ${errorMessage(err)}`)
      }
      if (resolved) {
        logger.log(`[tool-before] ${input.tool} callID=${input.callID} session=${input.sessionID} loop=${resolved.loopName} sandbox=${resolved.sandbox ? 'yes' : 'no'}`)
        if (resolved.active) {
          loopHandler.recordActivity(resolved.loopName, `tool-before:${input.tool}`)
          await loopPermissionPatcher.ensurePatched({ sessionID: input.sessionID, resolved })
        }
      }
      await toolExecuteBeforeHook!(input, output)
      await sandboxBeforeHook!(input, output)
    },
    toolAfter: async (input, output) => {
      let resolved: Awaited<ReturnType<typeof sessionLoopResolver.resolveActiveLoopForSession>> | null = null
      try {
        resolved = await sessionLoopResolver.resolveActiveLoopForSession(input.sessionID)
      } catch (err) {
        logger.debug(`[tool-after] loop resolution failed for session ${input.sessionID}: ${errorMessage(err)}`)
      }
      if (resolved) {
        logger.log(`[tool-after] ${input.tool} callID=${input.callID} output=${output.output?.slice(0, 200)}`)
        if (resolved.active) {
          loopHandler.recordActivity(resolved.loopName, `tool-after:${input.tool}`)
        }
      }
      await sandboxAfterHook!(input, output)
      await toolExecuteAfterHook!(input, output)
    },
    compacting: async (input, output) => {
      logger.log(`Compacting triggered`)
      await sessionHooks.onCompacting(
        input as { sessionID: string },
        output as { context: string[]; prompt?: string }
      )
    },
    architectReminderFor,
    systemAddendumFor,
    executeTuiPlan,
    loopDefaults,
    resolveSandboxForDirectory,
    resolveShellSandbox,
    autoApprovesPermissions: async (sessionID) => {
      const flag = await resolveAutoApproveFlag(sessionID)
      if (flag.enabled) {
        touchAutoApproveFlag(flag.flagOwnerId)
        return true
      }
      if (config.sandbox?.autoApprovePermissions === false) return false
      try {
        return (await resolveShellSandbox(sessionID)) !== null
      } catch (err) {
        logger.log(`[sandbox] permission auto-approval skipped for ${sessionID}: ${errorMessage(err)}`)
        return false
      }
    },
    isUnattendedGoalPlannerSession: (sessionID) => {
      try {
        const chunk = goalGoalsRepo.getChunkByPlannerSession(projectId, sessionID)
        if (chunk?.stage !== 'planning') return false
        return goalGoalsRepo.getGoal(projectId, chunk.goalId)?.status === 'running'
      } catch (err) {
        logger.log(`[goal] planner session lookup failed for ${sessionID}: ${errorMessage(err)}`)
        return false
      }
    },
    getSessionAutoApproveState,
    setSessionAutoApprove,
    autoApproveDenyRules,
    tui,
    cleanup,
    shellShimPath,
  }
}
