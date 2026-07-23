import type { Plugin, PluginInput, Hooks } from '@opencode-ai/plugin'
import { join } from 'path'
import type { ForgeClient, SessionGetParams } from './client/port'
import { buildAgents } from './agents'
import { createConfigHandler } from './config'
import { createSessionHooks, createLoopEventHandler } from './hooks'
import { initializeDatabase, resolveDataDir, resolveOpencodeToolOutputDir, closeDatabase, createLoopsRepo, createPlansRepo, createReviewFindingsRepo, createSectionPlansRepo, createLoopSessionUsageRepo, createFeatureGroupsRepo, createLoopTransitionsRepo, createPlanAmendmentsRepo, createLoopNewSessionOutcomesRepo, createLoopNewSessionCancellationsRepo, createLoopNewSessionRequestsRepo } from './storage'
import type { LoopChangeNotifier } from './loop'
import { loadPluginConfig, resolveBundledContainerDir, resolvePromptsDir } from './setup'
import { resolveLogPath } from './storage'
import { createLogger, slugify } from './utils/logger'
import { createDockerService } from './sandbox/docker'
import { defaultGitService } from './utils/git-service'
import { resolveSandboxContextForLoop, isSandboxConfigEnabled } from './sandbox/context'
import { resolveForgeTempDir } from './utils/opencode-paths'
import { isForgeWorktreeDir } from './workspace/forge-naming'
import { resolveLoopAllowedDirectories } from './constants/loop'
import { mkdirSync } from 'fs'
import { createSandboxManager } from './sandbox/manager'
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
import { createPlanCaptureEventHook } from './hooks/plan-capture'
import { createForgeSessionAttachHook, createForgeSessionMessageAttachHook } from './hooks/forge-session-attach'
import { createLoopPermissionPatcher } from './hooks/loop-permission'
import { createSandboxMessageHook } from './hooks/sandbox-message'
import { createGroupOrchestratorEventHook } from './hooks/group-orchestrator'
import { createGroupOrchestrator, mapLoopStateToOutcome, type GroupOrchestrator, type GroupEffects } from './services/group-orchestrator'
import { parseModelString } from './utils/model-fallback'
import { parseFeatureList } from './utils/feature-list-parser'
import { classifyArchitectOutput } from './utils/architect-auto-output'
import { captureLatestPlanForSession } from './services/plan-capture'
import { createForgeExecutionService, type ForgeExecutionRequestContext } from './services/execution'
import {
  forgeBridgeFromDispatch,
  registerForgeExecutionBridge,
  unregisterForgeExecutionBridge,
} from './services/execution-bridge'

export interface CreateParentSessionLookupOptions {
  client: ForgeClient
  directory: string
  loop: import('./loop').Loop
  logger: ReturnType<typeof createLogger>
  negativeTtlMs?: number
}

const PARENT_LOOKUP_NEGATIVE_TTL_MS = 15000

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

    const attempts: Array<{ label: string; directory?: string; input: Record<string, unknown> }> = []

    const seenDirectories = new Set<string>()
    const activeLoops = loop.listActive()

    for (const state of activeLoops) {
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
      attempts.push({
        label: 'host',
        directory,
        input: { sessionID: sessionId, directory },
      })
    }

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
        failures.push(`${attempt.label}[${attempt.directory ?? 'none'}]:${err instanceof Error ? err.message : String(err)}`)
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
}

export function createSessionDirectoryLookup({
  client,
  directory,
  loop,
}: CreateSessionDirectoryLookupOptions): (sessionId: string) => Promise<string | null> {
  const cache = new LRUCache<string | null>(500)

  return async (sessionId: string): Promise<string | null> => {
    if (cache.has(sessionId)) {
      return cache.get(sessionId) ?? null
    }

    const attempts: Array<{ label: string; directory?: string; input: Record<string, unknown> }> = []

    const seenDirectories = new Set<string>()
    const activeLoops = loop.listActive()

    for (const state of activeLoops) {
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
      attempts.push({
        label: 'host',
        directory,
        input: { sessionID: sessionId, directory },
      })
    }

    for (const attempt of attempts) {
      try {
        const session = await client.session.get(attempt.input as SessionGetParams)
        if (session && session.directory) {
          cache.set(sessionId, session.directory)
          return session.directory
        }
      } catch {
        // fall through to next attempt
      }
    }

    return null
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

    const loggingConfig = config.logging
    const logger = createLogger({
      enabled: loggingConfig?.enabled ?? false,
      file: loggingConfig?.file ?? resolveLogPath(),
      debug: loggingConfig?.debug ?? false,
    })
    logger.log(`Initializing plugin for directory: ${directory}, projectId: ${projectId}`)

    const forgeClient = createForgeClientFromPluginInput(input)

    const dataDir = config.dataDir || resolveDataDir()

    // Shared loop scratch directory, allowed in both worktree-only and sandbox modes. Created here
    // so it exists for host tools (worktree-only) and as a valid bind-mount source (sandbox).
    const forgeTempDir = resolveForgeTempDir(config.loop?.tmpDir)
    try {
      mkdirSync(forgeTempDir, { recursive: true })
    } catch (err) {
      logger.error(`Failed to create loop temp directory ${forgeTempDir}`, err)
    }

    let sandboxManager: ReturnType<typeof createSandboxManager> | null = null
    // The sandbox container runs as root (required by the nested Docker daemon), but the agent's
    // in-container shell commands run as the host UID:GID so files written to the bind-mounted
    // worktree are owned by the host user, not root. Undefined on platforms without UID concept.
    const hostExecUser = typeof process.getuid === 'function' && typeof process.getgid === 'function'
      ? `${process.getuid()}:${process.getgid()}`
      : undefined
    const dockerService = createDockerService(logger, { execUser: hostExecUser })
    if (!isSandboxConfigEnabled(config)) {
      logger.log('Docker sandbox disabled via config (sandbox.enabled=false); running in worktree-only mode')
    } else {
      try {
        sandboxManager = createSandboxManager(dockerService, {
          image: config.sandbox?.image ?? 'oc-forge-sandbox:latest',
          dataDir,
          toolOutputDir: resolveOpencodeToolOutputDir(),
          tmpDir: forgeTempDir,
          sourceProjectDir: directory,
          mountProjectReadonly: config.sandbox?.mountProjectReadonly,
          projectMountPath: config.sandbox?.projectMountPath,
          ...(config.sandbox?.mounts ? { customMounts: config.sandbox.mounts } : {}),
          buildContextDir: resolveBundledContainerDir(),
          ...(config.sandbox?.resources ? { resources: config.sandbox.resources } : {}),
          ...(config.sandbox?.network ? { network: config.sandbox.network } : {}),
        }, logger, defaultGitService)
        logger.log('Docker sandbox manager initialized')
      } catch (err) {
        logger.error('Failed to initialize Docker sandbox manager', err)
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
      const sandboxImage = config.sandbox?.image ?? 'oc-forge-sandbox:latest'
      const buildContextDir = resolveBundledContainerDir()
      void (async () => {
        try {
          const dockerOk = await dockerService.checkDocker()
          if (!dockerOk) return
          const exists = await dockerService.imageExists(sandboxImage)
          if (!exists) {
            logger.log(`Sandbox image "${sandboxImage}" not found — publishing toast`)
            await forgeClient.tui.publish({
              body: {
                type: 'tui.toast.show' as const,
                properties: {
                  title: 'Sandbox image not found',
                  message: `Docker image "${sandboxImage}" is missing. Build it from the command palette: "Build sandbox image", or run: docker build -t ${sandboxImage} "${buildContextDir}"`,
                  variant: 'warning' as const,
                  duration: 10_000,
                },
              },
            }).catch(() => {})
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
    const newSessionOutcomesRepo = createLoopNewSessionOutcomesRepo(db)
    const newSessionCancellationsRepo = createLoopNewSessionCancellationsRepo(db)
    const newSessionRequestsRepo = createLoopNewSessionRequestsRepo(db)

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

    const loopHandler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, projectId, forgeClient, logger, () => config, sandboxManager || undefined, dataDir, config.loop, sectionPlansRepo, notifyLoopChange, pendingTeardowns, loopSessionUsageRepo, loopTransitionsRepo, planAmendmentsRepo)

    const promptsDir = resolvePromptsDir()
    const agents = buildAgents(promptsDir)

    const compactionConfig: CompactionConfig | undefined = config.compaction
    const messagesTransformConfig = config.messagesTransform
    const sessionHooks = createSessionHooks(projectId, logger, input, compactionConfig)

    let cleanupPromise: Promise<void> | null = null

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

        unregisterForgeExecutionBridge(directory, tuiExecutionBridge)

        closeDatabase(db)
        logger.log('Plugin cleanup complete')
      })()
      return cleanupPromise
    }

    const handleExit = cleanup
    const handleSigint = cleanup
    const handleSigterm = cleanup

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
    const sessionDirectoryLookup = createSessionDirectoryLookup({ client: forgeClient, directory, loop: loopHandler.loop })
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
      getAllowExternalDirectories: () => resolveLoopAllowedDirectories(config),
    })
    const sandboxMessageHook = createSandboxMessageHook({
      sessionLoopResolver,
      logger,
    })
    // Resolves sandbox context for a session by following parent hops until an
    // active sandbox loop is found. Returns null if no sandbox is active for
    // the session or its ancestor.
    async function resolveSandboxForSession(sessionID: string) {
      const resolved = await sessionLoopResolver.resolveActiveLoopForSession(sessionID)
      return resolveSandboxContextForLoop(sandboxManager, resolved, logger)
    }

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
      const messages = await forgeClient.session.messages({ sessionID: sessionId, directory, limit: 20 })
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
      newSessionOutcomesRepo,
      newSessionCancellationsRepo,
      workspaceStatusRegistry,
      pendingTeardowns,
    })

    /**
     * Publish the audited plan.execute.newSession flow into the in-process
     * bridge registry so the TUI plugin (loaded alongside the server plugin
     * in the same opencode process) can dispatch new-session executions
     * through the same handler the execute-plan tool and plan-approval hook
     * use, instead of duplicating goal-loop persistence/runtime logic on the
     * TUI side. Unregistered on cleanup so stale bridges cannot outlive the
     * plugin; the unregister is identity-checked so a reloaded plugin cannot
     * remove a newer plugin's bridge.
     */
    const tuiExecutionBridge = forgeBridgeFromDispatch(
      (input) => ({
        surface: 'tui',
        projectId,
        directory,
        ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
      }),
      (ctx, command) => groupExecService.dispatch(ctx, command),
    )
    registerForgeExecutionBridge(directory, tuiExecutionBridge)

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
        const result = await captureLatestPlanForSession({
          client: forgeClient,
          plansRepo,
          projectId,
          directory,
          logger,
        }, sessionId)
        return { captured: result.status === 'captured' || result.status === 'already-current' }
      },

      async classifyArchitectFailure(sessionId) {
        const text = await findLatestAssistantText(sessionId)
        if (text === null) return { reason: 'No assistant response found' }
        const classified = classifyArchitectOutput(text)
        const reason = classified.kind === 'insufficient'
          ? classified.reason
          : 'Architect failed to produce a valid plan'
        return { reason }
      },

      async launchLoop({ architectSessionId, loopName }) {
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
      newSessionOutcomesRepo,
      newSessionCancellationsRepo,
      newSessionRequestsRepo,
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
        resolveActiveLoopForSession: sessionLoopResolver.resolveActiveLoopForSession,
        sandboxManager,
        ...(hostExecUser ? { execUser: hostExecUser } : {}),
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
        const resolved = await sessionLoopResolver.resolveActiveLoopForSession(input.sessionID)
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
        const resolved = await sessionLoopResolver.resolveActiveLoopForSession(input.sessionID)
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
READ-ONLY mode: no file edits, no destructive commands. Search and analyze only. Ask clarifying questions during research on scope, intent, or tradeoffs.

When emitting the final plan:
- Wrap the plan in \`<!-- forge-plan:start -->\` and \`<!-- forge-plan:end -->\` (each on its own line)
- Include one plain machine-readable \`Loop Name: short-slug\` line near the top of the marked plan, immediately after the objective. Do not emit loop name as a markdown heading or bullet.
- Use exactly one \`<!-- forge-section -->\` marker per executable phase; place it immediately before that phase's \`## Phase\` heading
- Do not insert \`<!-- forge-section -->\` before \`### Files\`, \`### Edits\`, \`### Acceptance Criteria\`, or \`### Verification\`
- Shared \`## Decisions\` / \`## Conventions\` / \`## Key Context\` blocks go after all sections (no preceding marker)
- After the plan, call the \`question\` tool with options: "New session", "Execute here", "Loop"
- If the user selects "Loop", launch it by calling the \`loop\` tool (the stored plan is used automatically); do not re-run the question tool.
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
export type { PluginConfig, CompactionConfig } from './types'
export { VERSION } from './version'
