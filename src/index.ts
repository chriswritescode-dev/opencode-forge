import type { Plugin, PluginInput, Hooks } from '@opencode-ai/plugin'
import { join } from 'path'
import type { ForgeClient, SessionGetParams } from './client/port'
import { ForgeClientError } from './client/port'
import { buildAgents } from './agents'
import { createConfigHandler } from './config'
import { createSessionHooks, createLoopEventHandler } from './hooks'
import { initializeDatabase, resolveDataDir, resolveOpencodeToolOutputDir, closeDatabase, createLoopsRepo, createPlansRepo, createReviewFindingsRepo, createSectionPlansRepo, createLoopSessionUsageRepo, createFeatureGroupsRepo, createLoopTransitionsRepo, createPlanAmendmentsRepo, createSessionSandboxPreferencesRepo } from './storage'
import type { LoopChangeNotifier } from './loop'
import { loadPluginConfig, resolveBundledContainerDir, resolvePromptsDir } from './setup'
import { resolveLogPath } from './storage'
import { createLogger, slugify } from './utils/logger'
import { createSbxRuntime, describeSbxUnavailable } from './sandbox/sbx'
import { collectLegacySandboxConfigWarnings } from './sandbox/config-warnings'
import { defaultGitService } from './utils/git-service'
import { resolveSandboxContextForLoop, isSandboxConfigEnabled } from './sandbox/context'
import { resolveOpencodeTmpDir } from './utils/opencode-paths'
import { isForgeWorktreeDir } from './workspace/forge-naming'
import { MAX_TOTAL_SECTIONS } from './constants/loop'
import { resolveLoopPermissionOptionsForWorkspace } from './utils/loop-permission-options'
import { emitLoopPermissionConfigWarnings } from './utils/loop-permission-warnings'
import { publishToast } from './utils/toast'
import { createSandboxManager } from './sandbox/manager'
import { DEFAULT_SANDBOX_IMAGE, formatTemplateBuildCommands } from './sandbox/template'
import { createSessionSandboxController, createUnavailableSandboxLifecycleManager, type ResolveActiveLoopForSession, type SessionSandboxController } from './sandbox/session-controller'
import type { PluginConfig, CompactionConfig } from './types'
import { createTools } from './tools'
import { createToolExecuteBeforeHook, createToolExecuteAfterHook, createPlanApprovalEventHook } from './hooks'
import { createSandboxToolBeforeHook, createSandboxToolAfterHook } from './hooks/sandbox-tools'
import { createShellEnvHook } from './hooks/shell-env'
import { ensureShellShim } from './sandbox/shell-shim'
import type { ToolContext } from './tools'
import { createForgeClientFromPluginInput } from './client/sdk-adapter'

import { LRUCache } from './utils/lru-cache'
import { createSessionLoopResolver } from './services/session-loop-resolver'
import { createUnifiedSandboxResolver } from './services/unified-sandbox-resolver'
import { createPlanCaptureEventHook } from './hooks/plan-capture'
import { createForgeSessionAttachHook, createForgeSessionMessageAttachHook } from './hooks/forge-session-attach'
import { createLoopPermissionPatcher } from './hooks/loop-permission'
import { createSandboxMessageHook } from './hooks/sandbox-message'
import { createGroupOrchestratorEventHook } from './hooks/group-orchestrator'
import { createGroupOrchestrator, mapLoopStateToOutcome, type GroupOrchestrator, type GroupEffects } from './services/group-orchestrator'
import { parseModelString } from './utils/model-fallback'
import { parseFeatureList } from './utils/feature-list-parser'
import { classifyArchitectOutput, inspectArchitectPlanReadiness } from './utils/architect-auto-output'
import { resolveSessionPlanOfRecord } from './services/plan-capture'
import { PLAN_CAPTURE_MESSAGE_LIMIT } from './utils/marked-plan-parser'
import { createForgeExecutionService, type ForgeExecutionRequestContext } from './services/execution'

export interface CreateParentSessionLookupOptions {
  client: ForgeClient
  directory: string
  loop: import('./loop').Loop
  logger: ReturnType<typeof createLogger>
  negativeTtlMs?: number
}

const PARENT_LOOKUP_NEGATIVE_TTL_MS = 15000

type SessionLookupAttempt = { label: string; directory?: string; input: Record<string, unknown> }

function buildSessionLookupAttempts(
  sessionId: string,
  directory: string,
  loop: import('./loop').Loop,
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
  negativeTtlMs = PARENT_LOOKUP_NEGATIVE_TTL_MS,
}: CreateParentSessionLookupOptions): (sessionId: string) => Promise<string | null> {
  const cache = new LRUCache<string | null>(500)
  const negativeCache = new Map<string, number>()

    return async (sessionId: string): Promise<string | null> => {
    if (cache.has(sessionId)) {
      return cache.get(sessionId) ?? null
    }

    const negExpiry = negativeCache.get(sessionId)
    if (negExpiry !== undefined) {
      if (negExpiry > Date.now()) return null
      negativeCache.delete(sessionId)
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
        // Only definitive absence (a not-found response) is treated as a negative
        // result. Transient failures (connection/unavailable/request) propagate so
        // sandbox routing fails closed instead of caching a false "no parent".
        if (err instanceof ForgeClientError && err.kind === 'not-found') {
          failures.push(`${attempt.label}[${attempt.directory ?? 'none'}]:not-found`)
          continue
        }
        throw err
      }
    }

    negativeCache.set(sessionId, Date.now() + negativeTtlMs)
    if (failures.length > 0) {
      logger.log(`[session-resolver] session.get failed for ${sessionId} across ${attempts.length} attempts: ${failures.join('; ')}`)
    }
    return null
  }
}

export interface CreateSessionDirectoryLookupOptions {
  client: ForgeClient
  directory: string
  loop: import('./loop').Loop
  negativeTtlMs?: number
}

interface SessionSandboxIdentity {
  projectId: string
  directory: string
}

function createSessionIdentityLookup({
  client,
  directory,
  loop,
  negativeTtlMs = PARENT_LOOKUP_NEGATIVE_TTL_MS,
}: CreateSessionDirectoryLookupOptions, requireProjectId = true): (sessionId: string) => Promise<SessionSandboxIdentity | null> {
  const cache = new LRUCache<SessionSandboxIdentity>(500)
  const negativeCache = new Map<string, number>()

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

const sharedSessionSandboxControllers = new Map<string, SharedSessionSandboxController>()

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

/**
 * Creates an OpenCode plugin instance with loop management and sandboxing.
 * 
 * @param config - Plugin configuration including loop, sandbox, and logging settings
 * @returns OpenCode Plugin instance with hooks for tools, events, and session management
 */
export function createForgePlugin(config: PluginConfig): Plugin {
  return async (input: PluginInput): Promise<Hooks> => {
    const { directory, project } = input
    const projectId = project.id
    const projectRoot = project.worktree ?? directory

    const loggingConfig = config.logging
    const logger = createLogger({
      enabled: loggingConfig?.enabled ?? false,
      file: loggingConfig?.file ?? resolveLogPath(),
      debug: loggingConfig?.debug ?? false,
    })
    logger.log(`Initializing plugin for directory: ${directory}, projectId: ${projectId}`)

    for (const warning of collectLegacySandboxConfigWarnings(config.sandbox as unknown)) {
      logger.log(warning)
    }

    const forgeClient = createForgeClientFromPluginInput(input)

    const dataDir = config.dataDir || resolveDataDir()

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

    let sandboxManager: ReturnType<typeof createSandboxManager> | null = null
    const runtime = createSbxRuntime(logger)
    if (!isSandboxConfigEnabled(config)) {
      logger.log('Sandbox disabled via config (sandbox.enabled=false); running in worktree-only mode')
    } else {
      try {
        sandboxManager = createSandboxManager(runtime, {
          image: config.sandbox?.image ?? DEFAULT_SANDBOX_IMAGE,
          dataDir,
          toolOutputDir: resolveOpencodeToolOutputDir(),
          tmpDir: resolveOpencodeTmpDir(),
          sourceProjectDir: projectRoot,
          mountProjectReadonly: config.sandbox?.mountProjectReadonly,
          ...(config.sandbox?.mounts ? { customMounts: config.sandbox.mounts } : {}),
          ...(config.sandbox?.network ? { network: config.sandbox.network } : {}),
          buildContextDir: resolveBundledContainerDir(),
          browserControl: config.sandbox?.imageFeatures?.browserControl === true,
          ...(config.sandbox?.resources ? { resources: config.sandbox.resources } : {}),
        }, logger, defaultGitService)
        logger.log('Sandbox manager initialized')
      } catch (err) {
        logger.error('Failed to initialize sbx sandbox manager', err)
      }
    }

    // Sandbox shell routing: opencode's native bash tool is pointed at a shim (via the `shell`
    // config key) that routes commands into the loop container when the shell.env hook injects
    // the container name. Without a working shim there is no safe way to route sandbox loop
    // commands, so degrade to worktree-only mode rather than silently executing on the host.
    // Known ceiling: the shim is POSIX sh, so Windows hosts run worktree-only; a cmd/pwsh shim
    // would be the upgrade path.
    let shellShimPath: string | null = null
    if (sandboxManager) {
      shellShimPath = process.platform === 'win32' ? null : ensureShellShim(dataDir, logger)
      if (!shellShimPath) {
        logger.error('Sandbox shell shim unavailable; falling back to worktree-only mode')
        sandboxManager = null
      }
    }
    // The shell the user had configured before forge overrode `shell` with the shim; injected
    // back via shell.env for non-sandbox sessions so their bash tool behavior is unchanged.
    let userConfiguredShell: string | undefined

    if (sandboxManager && forgeClient) {
      const sandboxImage = config.sandbox?.image ?? DEFAULT_SANDBOX_IMAGE
      const buildContextDir = resolveBundledContainerDir()
      const browserControl = config.sandbox?.imageFeatures?.browserControl === true
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
                message: describeSbxUnavailable(available),
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
              message: `Sandbox template "${sandboxImage}" is missing. Build it from the command palette: "Build sandbox template", or run: ${formatTemplateBuildCommands(buildContextDir, sandboxImage, { browserControl })}`,
              variant: 'warning',
              duration: 10_000,
            })
          }
        } catch (err: unknown) {
          logger.log(`Sandbox image check: ${err instanceof Error ? err.message : String(err)}`)
        }
      })()
    }

    // Pending-teardown registry: caller (loop termination side-effects) writes
    // iteration/reason/doCommit here right before invoking workspace.remove so
    // the forge adapter can build informative commit messages while remaining
    // the single source of truth for teardown behavior.
    const { createPendingTeardownRegistry } = await import('./workspace/pending-teardown')
    const pendingTeardowns = createPendingTeardownRegistry()

    // Workspace status registry: tracks connected/connecting/disconnected/error
    // state per workspace and exposes awaitConnected for deterministic readiness.
    const { createWorkspaceStatusRegistry } = await import('./utils/workspace-status-registry')
    const workspaceStatusRegistry = createWorkspaceStatusRegistry({ logger })

    // Register the forge workspace adapter so loop worktrees are created under <dataDir>/worktrees/
    if (input.experimental_workspace?.register) {
      const { createForgeWorkspaceAdapter } = await import('./workspace/forge-adapter')
      input.experimental_workspace.register('forge', createForgeWorkspaceAdapter({
        dataDir,
        logger,
        sandboxManager,
        gitService: defaultGitService,
        getTeardownContext: (loopName) => pendingTeardowns.get(loopName),
        worktreeOpencodeConfig: config.loop?.worktreeOpencodeConfig,
      }))
      logger.log(`Registered forge workspace adapter (worktrees under ${join(dataDir, 'worktrees')})`)
    }

    const db = initializeDatabase(dataDir, { completedLoopTtlMs: config.completedLoopTtlMs })

    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const loopSessionUsageRepo = createLoopSessionUsageRepo(db)
    const featureGroupsRepo = createFeatureGroupsRepo(db)
    const loopTransitionsRepo = createLoopTransitionsRepo(db)
    const planAmendmentsRepo = createPlanAmendmentsRepo(db)

    // Mark any groups left in non-terminal status (extracting/planning/running) from a
    // prior process as interrupted. Do NOT auto-resume — user must restart via group-status.
    //
    // Skip this for forge worktree directories: when a loop (including a group's own
    // loops) creates its worktree, OpenCode spins up a fresh plugin instance for that
    // child directory in the SAME project. Running recovery there would mark the still-
    // active parent group interrupted, sabotaging the group that just launched the loop.
    if (!isForgeWorktreeDir(dataDir, directory)) {
      const interruptedCount = featureGroupsRepo.markInterrupted(projectId)
      if (interruptedCount > 0) {
        logger.log(`Startup: marked ${interruptedCount} group(s) as interrupted (no auto-resume)`)
      }
    }

    // Forward reference — assigned after real effects are built (post sessionLoopResolver).
    // eslint-disable-next-line prefer-const
    let groupOrchestrator: GroupOrchestrator | undefined

    const notifyLoopChange: LoopChangeNotifier = (reason, loopName, hint) => {
      const targetDirectories = Array.from(new Set([
        hint?.projectDir,
        hint?.worktreeDir,
        directory,
      ].filter((dir): dir is string => !!dir)))
      logger.debug(`[notifyLoopChange] reason=${reason} loop=${loopName} dirs=${targetDirectories.join(',')} projectId=${projectId}`)

      // When a loop terminates, notify the group orchestrator so it can advance
      // the next queued feature. Fire-and-forget — the orchestrator guards internally
      // against non-group loops.
      if (reason === 'terminate') {
        groupOrchestrator?.onLoopTerminated(loopName).catch((err: unknown) => {
          logger.error(`[notifyLoopChange] groupOrchestrator.onLoopTerminated failed for loop=${loopName}:`, err as Error)
        })
      }
    }

    const loopHandler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, projectId, forgeClient, logger, () => config, sandboxManager || undefined, dataDir, config.loop, sectionPlansRepo, notifyLoopChange, pendingTeardowns, loopSessionUsageRepo, loopTransitionsRepo, planAmendmentsRepo, directory)

    const promptsDir = resolvePromptsDir()
    const agents = buildAgents(promptsDir)

    const compactionConfig: CompactionConfig | undefined = config.compaction
    const messagesTransformConfig = config.messagesTransform
    const sessionHooks = createSessionHooks(projectId, logger, input, compactionConfig)

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
          sandboxManager?.dispose()
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
    // work would be cut off mid-flight. The awaited shutdown runs through the
    // `server.instance.disposed` event and the SIGINT/SIGTERM handlers (which keep the process
    // alive while their async cleanup completes). This listener is registered so shutdown
    // bookkeeping is explicit and cleaned up consistently with the other signals.
    const handleExit = () => {}

    process.once('exit', handleExit)
    process.once('SIGINT', handleSigint)
    process.once('SIGTERM', handleSigterm)

    const getCleanup = cleanup

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
      workspaceStatusRegistry,
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
    const sessionIdentityLookup = createSessionIdentityLookup({ client: forgeClient, directory, loop: loopHandler.loop })
    const sessionDirectoryLookup = async (sessionId: string) => (await sessionIdentityLookup(sessionId))?.directory ?? null
    const sessionLoopResolver = createSessionLoopResolver({
      loop: loopHandler.loop,
      getParentSessionId: parentSessionLookup,
      getSessionDirectory: sessionDirectoryLookup,
      logger,
    })
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
      resolveSandboxForSession: (sessionID) => resolveSandboxForSession(sessionID),
      logger,
    })

    // Spawns an isolated agent session (splitter/architect) seeded with a single text prompt,
    // using the configured auditor model. Single source of truth for group agent bring-up.
    async function spawnAgentSession(title: string, text: string, agent: string): Promise<{ sessionId: string }> {
      const session = await forgeClient.session.create({ title, directory })
      const parsedModel = parseModelString(config.auditorModel)
      const modelParam = parsedModel ? { model: parsedModel } : {}
      await forgeClient.session.promptAsync({
        sessionID: session.id,
        directory,
        parts: [{ type: 'text', text }],
        agent,
        ...modelParam,
      })
      return { sessionId: session.id }
    }

    // Returns the newest assistant text part across a session's messages, or null if none.
    async function findLatestAssistantText(sessionId: string): Promise<string | null> {
      const messages = await forgeClient.session.messages({ sessionID: sessionId, directory, limit: PLAN_CAPTURE_MESSAGE_LIMIT })
      const msgs = (messages ?? []) as Array<{ info: { role?: string }; parts: Array<{ type: string; text?: string }> }>
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        if (msg.info.role !== 'assistant') continue
        for (const part of msg.parts) {
          if (part.type === 'text' && part.text) return part.text
        }
      }
      return null
    }

    function inspectStoredArchitectPlan(sessionId: string) {
      const plan = plansRepo.getForSession(projectId, sessionId)
      return plan ? inspectArchitectPlanReadiness(plan.content) : null
    }

    // Execution service for group-launched loops. Built once and reused across launch/cancel
    // (stateless dispatch) so the dependency wiring lives in a single place.
    const groupExecService = createForgeExecutionService({
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
      loopSessionUsageRepo,
      workspaceStatusRegistry,
      pendingTeardowns,
    })

    // ── Real GroupEffects ─────────────────────────────────────────────────────
    const effects: GroupEffects = {
      async spawnSplitterSession(prdText) {
        return spawnAgentSession('Feature extraction', prdText, 'feature-splitter')
      },

      async readSplitterFeatures(sessionId) {
        const text = await findLatestAssistantText(sessionId)
        if (text === null) return { ok: false, reason: 'missing' as const }
        return parseFeatureList(text)
      },

      async spawnArchitectSession(feature) {
        return spawnAgentSession(`Plan: ${feature.title}`, feature.description, 'architect-auto')
      },

      async capturePlan(sessionId) {
        const captured = await resolveSessionPlanOfRecord({
          client: forgeClient,
          plansRepo,
          projectId,
          directory,
          logger,
        }, sessionId)
        if (!captured) return { captured: false }

        const readiness = inspectStoredArchitectPlan(sessionId)
        if (!readiness?.ready) {
          logger.log(`group-orchestrator: architect ${sessionId} stored an incomplete plan: ${readiness?.reason ?? 'plan row missing after capture'}`)
          return { captured: false }
        }
        return { captured: true }
      },

      async classifyArchitectFailure(sessionId) {
        const readiness = inspectStoredArchitectPlan(sessionId)
        if (readiness && !readiness.ready) return { reason: readiness.reason }

        const text = await findLatestAssistantText(sessionId)
        if (text === null) return { reason: 'No assistant response found' }
        const classified = classifyArchitectOutput(text)
        const reason = classified.kind === 'insufficient'
          ? classified.reason
          : 'Architect failed to produce a valid plan'
        return { reason }
      },

      async launchLoop({ architectSessionId, loopName }) {
        const readiness = inspectStoredArchitectPlan(architectSessionId)
        if (!readiness?.ready) {
          return {
            ok: false,
            error: readiness?.reason ?? 'Stored plan not found before launch',
          }
        }

        const execCtx: ForgeExecutionRequestContext = {
          surface: 'tool',
          projectId,
          directory,
          sourceSessionId: architectSessionId,
        }
        const response = await groupExecService.dispatch(execCtx, {
          type: 'loop.start',
          source: { kind: 'stored', sessionId: architectSessionId },
          loopName,
          executionModel: config.executionModel,
          auditorModel: config.auditorModel,
          lifecycle: { startWatchdog: true },
        })
        if (response.ok) {
          return { ok: true, loopName: response.data.loopName }
        }
        return { ok: false, error: response.error?.message ?? 'Failed to start loop' }
      },

      async cancelLoop(loopName) {
        await groupExecService.dispatch(
          { surface: 'tool', projectId, directory },
          { type: 'loop.cancel', selector: { kind: 'exact', name: loopName } },
        )
      },

      loopFinalOutcome(loopName) {
        const state = loopHandler.loop.service.getAnyState(loopName)
        return mapLoopStateToOutcome(state)
      },

      generateLoopName(base) {
        return loopHandler.loop.service.generateUniqueLoopName(slugify(base))
      },
    }

    groupOrchestrator = createGroupOrchestrator({
      projectId,
      repo: featureGroupsRepo,
      effects,
      cap: () => config.groupLaunch?.maxConcurrentLoops ?? 3,
      logger,
    })

    const groupOrchestratorEventHook = createGroupOrchestratorEventHook({
      orchestrator: groupOrchestrator,
      repo: featureGroupsRepo,
      projectId,
      logger,
    })

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
      sectionPlansRepo,
      loopSessionUsageRepo,
      workspaceStatusRegistry,
      pendingTeardowns,
      resolveActiveLoopForSession: sessionLoopResolver.resolveActiveLoopForSession,
      featureGroupsRepo,
      groupOrchestrator,
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

    return {
      getCleanup,
      tool: tools,
      config: (() => {
        const handler = createConfigHandler(agents, config.agents, promptsDir)
        return async (cfg: Record<string, unknown>) => {
          await handler(cfg)
          if (!shellShimPath) return
          const existingShell = cfg.shell
          if (typeof existingShell === 'string' && existingShell && existingShell !== shellShimPath) {
            userConfiguredShell = existingShell
          }
          cfg.shell = shellShimPath
        }
      })(),
      'shell.env': createShellEnvHook({
        resolveSandboxForSession,
        getUserConfiguredShell: () => userConfiguredShell,
        logger,
      }),
      'chat.message': async (input, output) => {
        await forgeSessionMessageAttachHook(input)
        // Fallback for filtered session.created events: subagent sessions inside
        // loops must carry the loop ruleset before their first LLM step.
        await loopPermissionPatcher.ensurePatched({ sessionID: input.sessionID })
        await sessionHooks.onMessage(input, output)
      },
      'experimental.chat.system.transform': async (input, output) => {
        await sandboxMessageHook(
          input as { sessionID?: string },
          output as { system: string[] },
        )
      },
      event: async (input) => {
        const eventInput = input as { event: { type: string; properties?: Record<string, unknown> } }
        const event = eventInput.event
        try { workspaceStatusRegistry.recordEvent(event) } catch { /* defensive */ }
        if (eventInput.event?.type === 'server.instance.disposed') {
          await cleanup()
          return
        }
        await planCaptureEventHook(eventInput)
        await loopHandler.onEvent(eventInput)
        await groupOrchestratorEventHook(eventInput)
        await loopPermissionPatcher.onSessionCreated(eventInput)
        await forgeSessionAttachHook(eventInput)
        await sessionHooks.onEvent(eventInput)
        await planApprovalEventHook(eventInput)
      },
      'tool.execute.before': async (input, output) => {
        // Loop bookkeeping (activity recording, permission patching) is best-effort for tool
        // routing: a transient ancestry/session lookup failure must never reject native file and
        // management tools (`read`, `edit`, `write`, ...), which are host-side by design.
        // Sandbox-routed tools (bash/glob/grep) still fail closed through their own resolver
        // calls, so shell + search isolation is not weakened.
        let resolved: Awaited<ReturnType<typeof sessionLoopResolver.resolveActiveLoopForSession>> | null = null
        try {
          resolved = await sessionLoopResolver.resolveActiveLoopForSession(input.sessionID)
        } catch (err) {
          logger.debug(`[tool-before] loop resolution failed for session ${input.sessionID}: ${err instanceof Error ? err.message : String(err)}`)
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
      'tool.execute.after': async (input, output) => {
        let resolved: Awaited<ReturnType<typeof sessionLoopResolver.resolveActiveLoopForSession>> | null = null
        try {
          resolved = await sessionLoopResolver.resolveActiveLoopForSession(input.sessionID)
        } catch (err) {
          logger.debug(`[tool-after] loop resolution failed for session ${input.sessionID}: ${err instanceof Error ? err.message : String(err)}`)
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
      'experimental.session.compacting': async (input, output) => {
        logger.log(`Compacting triggered`)
        await sessionHooks.onCompacting(
          input as { sessionID: string },
          output as { context: string[]; prompt?: string }
        )
      },
      'experimental.chat.messages.transform': async (
        _input: Record<string, never>,
        output: { messages: Array<{ info: { role: string; agent?: string; id?: string }; parts: Array<Record<string, unknown>> }> }
      ) => {
        const messages = output.messages
        let userMessage: typeof messages[number] | undefined
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].info.role === 'user') {
            userMessage = messages[i]
            break
          }
        }

        if (!userMessage) return

        const messagesTransformEnabled = messagesTransformConfig?.enabled ?? true
        if (!messagesTransformEnabled) return

        const isArchitect = userMessage.info.agent === agents.architect.displayName
        if (!isArchitect) return

        userMessage.parts.push({
          type: 'text',
          text: `<system-reminder>
READ-ONLY filesystem mode: search and analyze only; plan-write and plan-edit may update plan storage.
Finalize the complete stored plan with at most ${MAX_TOTAL_SECTIONS} phases and fix every structure-report warning, then summarize the plan in chat and stop. Do not call the \`question\` tool and do not launch anything — the user decides whether and how to execute.
</system-reminder>`,
          synthetic: true,
        })
      },
    } as Hooks & { getCleanup: () => Promise<void> }
  }
}

const plugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  const config = loadPluginConfig()

  const factory = createForgePlugin(config)
  const hooks = await factory(input)

  return hooks
}

const pluginModule = {
  id: 'oc-forge',
  server: plugin,
}

export default pluginModule
export type { PluginConfig, CompactionConfig, DashboardConfig } from './types'
export { VERSION } from './version'
