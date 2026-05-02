import type { Plugin, PluginInput, Hooks } from '@opencode-ai/plugin'
import { createOpencodeClient as createV2Client } from '@opencode-ai/sdk/v2'
import { buildAgents } from './agents'
import { createConfigHandler } from './config'
import { createSessionHooks, createLoopEventHandler } from './hooks'
import { initializeDatabase, resolveDataDir, closeDatabase, createLoopsRepo, createPlansRepo, createReviewFindingsRepo } from './storage'
import { createLoopService } from './services/loop'
import { createGraphService } from './graph'
import { loadPluginConfig } from './setup'
import { resolveLogPath } from './storage'
import { createLogger } from './utils/logger'
import { createDockerService } from './sandbox/docker'
import { createSandboxManager } from './sandbox/manager'
import { reconcileSandboxes } from './sandbox/reconcile'
import type { PluginConfig, CompactionConfig } from './types'
import { createTools, createToolExecuteBeforeHook, createToolExecuteAfterHook, createPlanApprovalEventHook } from './tools'
import { createSandboxToolBeforeHook, createSandboxToolAfterHook } from './hooks/sandbox-tools'
import { createGraphCommandEventHook } from './hooks/graph-command'
import { createGraphToolBeforeHook, createGraphToolAfterHook } from './hooks/graph-tools'
import type { ToolContext } from './tools'
import type { GraphService } from './graph'
import { createGraphStatusCallback, writeGraphStatus, UNAVAILABLE_STATUS } from './utils/graph-status-store'
import { createGraphStatusRepo } from './storage'
import { FORGE_WORKTREE_WORKSPACE_TYPE, createForgeWorktreeAdaptor } from './workspace/forge-worktree'
import { LRUCache } from './utils/lru-cache'
import { createSessionLoopResolver } from './services/session-loop-resolver'
import { createPermissionAskHandler } from './hooks/permission-ask'
import { getProjectRegistry } from './api/project-registry'
import type { ProjectRegistry } from './api/project-registry'
import { createPlanCaptureEventHook } from './hooks/plan-capture'
import { createBusRpcEventHook } from './api/bus-rpc'

export async function cleanupSandboxOrphansAcrossRegistry(
  registry: ProjectRegistry,
  sandboxManager: Pick<ReturnType<typeof createSandboxManager>, 'cleanupOrphans'>
): Promise<string[]> {
  const preserveLoops = registry
    .list()
    .flatMap((ctx) => ctx.loopService.listActive())
    .filter((state) => state.sandbox && state.loopName)
    .map((state) => state.loopName!)

  await sandboxManager.cleanupOrphans(preserveLoops)
  return preserveLoops
}

export interface CreateParentSessionLookupOptions {
  v2: ReturnType<typeof createV2Client>
  directory: string
  loopService: ReturnType<typeof createLoopService>
  logger: ReturnType<typeof createLogger>
  negativeTtlMs?: number
}

const PARENT_LOOKUP_NEGATIVE_TTL_MS = 2000

export function createParentSessionLookup({
  v2,
  directory,
  loopService,
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

    type SessionGetInput = Parameters<typeof v2.session.get>[0]

    const attempts: Array<{ label: string; directory?: string; input: SessionGetInput }> = [
      { label: 'no-dir', input: { sessionID: sessionId } as SessionGetInput },
    ]

    const seenDirectories = new Set<string>()
    for (const state of loopService.listActive()) {
      if (!state.worktreeDir || seenDirectories.has(state.worktreeDir)) continue
      seenDirectories.add(state.worktreeDir)
      attempts.push({
        label: `loop:${state.loopName}`,
        directory: state.worktreeDir,
        input: { sessionID: sessionId, directory: state.worktreeDir } as SessionGetInput,
      })
    }

    if (!seenDirectories.has(directory)) {
      attempts.push({
        label: 'host',
        directory,
        input: { sessionID: sessionId, directory } as SessionGetInput,
      })
    }

    const failures: string[] = []

    for (const attempt of attempts) {
      try {
        const result = await v2.session.get(attempt.input)
        if (result.data) {
          const parentId = result.data.parentID ?? null
          cache.set(sessionId, parentId)
          return parentId
        }
        failures.push(`${attempt.label}[${attempt.directory ?? 'none'}]:empty`)
      } catch (err) {
        failures.push(`${attempt.label}[${attempt.directory ?? 'none'}]:${err instanceof Error ? err.message : String(err)}`)
      }
    }

    negativeCache.set(sessionId, Date.now() + negativeTtlMs)
    logger.log(`[session-resolver] session.get failed for ${sessionId} across ${attempts.length} attempts: ${failures.join('; ')}`)
    return null
  }
}

export interface CreateSessionDirectoryLookupOptions {
  v2: ReturnType<typeof createV2Client>
  directory: string
  loopService: ReturnType<typeof createLoopService>
}

export function createSessionDirectoryLookup({
  v2,
  directory,
  loopService,
}: CreateSessionDirectoryLookupOptions): (sessionId: string) => Promise<string | null> {
  const cache = new LRUCache<string | null>(500)

  return async (sessionId: string): Promise<string | null> => {
    if (cache.has(sessionId)) {
      return cache.get(sessionId) ?? null
    }

    type SessionGetInput = Parameters<typeof v2.session.get>[0]

    const attempts: Array<{ label: string; directory?: string; input: SessionGetInput }> = [
      { label: 'no-dir', input: { sessionID: sessionId } as SessionGetInput },
    ]

    const seenDirectories = new Set<string>()
    for (const state of loopService.listActive()) {
      if (!state.worktreeDir || seenDirectories.has(state.worktreeDir)) continue
      seenDirectories.add(state.worktreeDir)
      attempts.push({
        label: `loop:${state.loopName}`,
        directory: state.worktreeDir,
        input: { sessionID: sessionId, directory: state.worktreeDir } as SessionGetInput,
      })
    }

    if (!seenDirectories.has(directory)) {
      attempts.push({
        label: 'host',
        directory,
        input: { sessionID: sessionId, directory } as SessionGetInput,
      })
    }

    for (const attempt of attempts) {
      try {
        const result = await v2.session.get(attempt.input)
        if (result.data?.directory) {
          cache.set(sessionId, result.data.directory)
          return result.data.directory
        }
      } catch {
        // fall through to next attempt
      }
    }

    return null
  }
}


/**
 * Creates an OpenCode plugin instance with loop management, graph indexing, and sandboxing.
 * 
 * @param config - Plugin configuration including loop, graph, sandbox, and logging settings
 * @returns OpenCode Plugin instance with hooks for tools, events, and session management
 */
export function createForgePlugin(config: PluginConfig): Plugin {
  return async (input: PluginInput): Promise<Hooks> => {
    const { directory, project, client } = input
    const projectId = project.id

    const serverUrl = input.serverUrl
    
    // Extract legacy fetch for in-process dispatch
    const legacyHttp = (client as unknown as { _client?: { getConfig: () => { fetch?: typeof fetch } } })._client
    const legacyFetch = legacyHttp?.getConfig?.().fetch
    const v2ClientConfig: Parameters<typeof createV2Client>[0] = {
      baseUrl: serverUrl.toString(),
      directory,
      ...(legacyFetch ? { fetch: legacyFetch } : {}),
    }
    const v2 = createV2Client(v2ClientConfig)

    const loggingConfig = config.logging
    const logger = createLogger({
      enabled: loggingConfig?.enabled ?? false,
      file: loggingConfig?.file ?? resolveLogPath(),
      debug: loggingConfig?.debug ?? false,
    })
    logger.log(`Initializing plugin for directory: ${directory}, projectId: ${projectId}`)
    logger.log(`v2 client fetch: ${legacyFetch ? 'in-process' : 'globalThis'}`)

    const dataDir = config.dataDir || resolveDataDir()
    
    const db = initializeDatabase(dataDir, { completedLoopTtlMs: config.completedLoopTtlMs })

    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)

    const loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger, config.loop)

    const activeSandboxLoops = loopService.listActive().filter(s => s.sandbox && s.loopName)

    const reconciledCount = loopService.reconcileStale()
    if (reconciledCount > 0) {
      logger.log(`Reconciled ${reconciledCount} stale loop(s) from previous session`)
    }

    let sandboxManager: ReturnType<typeof createSandboxManager> | null = null
    if (config.sandbox?.mode === 'docker') {
      const dockerService = createDockerService(logger)
      try {
        sandboxManager = createSandboxManager(dockerService, {
          image: config.sandbox?.image || 'oc-forge-sandbox:latest',
        }, logger)
        logger.log('Docker sandbox manager initialized')
      } catch (err) {
        logger.error('Failed to initialize Docker sandbox manager', err)
      }
    }

    // Sandbox reconciliation interval handle
    let sandboxReconcileInterval: ReturnType<typeof setInterval> | null = null

    const loopHandler = createLoopEventHandler(loopService, client, v2, logger, () => config, sandboxManager || undefined, projectId, dataDir)

    // Initialize graph service if enabled
    const graphEnabled = config.graph?.enabled ?? true
    const agents = buildAgents({ graphEnabled })
    let graphService: GraphService | null = null
    const graphStatusRepo = createGraphStatusRepo(db)
    
    if (graphEnabled) {
      try {
        // Create status callback for persisting graph state (scoped to cwd for worktree sessions)
        const graphStatusCallback = createGraphStatusCallback(graphStatusRepo, projectId, directory)
        
        graphService = createGraphService({
          projectId,
          dataDir,
          cwd: directory,
          logger,
          watch: config.graph?.watch ?? true,
          debounceMs: config.graph?.debounceMs,
          onStatusChange: graphStatusCallback,
        })
        
        // Guarded auto-scan if enabled - checks cache freshness before scanning
        const autoScan = config.graph?.autoScan ?? true
        if (autoScan) {
          graphService.ensureStartupIndex().catch((err: unknown) => {
            logger.error('Graph startup index check failed', err)
          })
        }
      } catch (err) {
        logger.error('Failed to initialize graph service', err)
        graphService = null
      }
    } else {
      // Graph is disabled - persist unavailable status
      writeGraphStatus(graphStatusRepo, projectId, UNAVAILABLE_STATUS)
    }

    const compactionConfig: CompactionConfig | undefined = config.compaction
    const messagesTransformConfig = config.messagesTransform
    const sessionHooks = createSessionHooks(projectId, logger, input, compactionConfig)
    const registry = getProjectRegistry()

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

        // Clear sandbox reconciliation interval
        if (sandboxReconcileInterval) {
          clearInterval(sandboxReconcileInterval)
          sandboxReconcileInterval = null
        }

        registry.unregister(projectId)

        logger.log('Loop: active loops preserved during plugin cleanup')
        
        loopHandler.clearAllRetryTimeouts()
        
        if (graphService) {
          await graphService.close()
          logger.log('Graph service closed')
        }
        
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

    const ctx: ToolContext = {
      projectId,
      directory,
      config,
      logger,
      db,
      dataDir,
      loopService,
      loopHandler,
      v2,
      cleanup,
      input,
      sandboxManager,
      graphService: graphService || null,
      plansRepo,
      reviewFindingsRepo,
      graphStatusRepo,
      loopsRepo,
    }

    registry.register(ctx)

    if (sandboxManager) {
      await cleanupSandboxOrphansAcrossRegistry(registry, sandboxManager)

      for (const loop of activeSandboxLoops) {
        try {
          await sandboxManager.restore(loop.loopName!, loop.worktreeDir, loop.startedAt)
          loopService.setStatus(loop.loopName!, 'running')
          logger.log(`Restored sandbox and reactivated loop for ${loop.loopName}`)
        } catch (err) {
          logger.error(`Failed to restore sandbox for ${loop.loopName}`, err)
        }
      }

      const reconcileDeps = { sandboxManager, loopService, logger }
      await reconcileSandboxes(reconcileDeps)

      sandboxReconcileInterval = setInterval(() => {
        reconcileSandboxes(reconcileDeps).catch((err) => {
          logger.error('Sandbox reconciliation failed', err)
        })
      }, 2000)
    }

    // Create bus-RPC event hook for handling TUI plugin RPC calls
    const busRpcHook = createBusRpcEventHook({ registry, logger, v2, instanceDirectory: directory })

    const tools = createTools(ctx)
    const toolExecuteBeforeHook = createToolExecuteBeforeHook(ctx)
    const toolExecuteAfterHook = createToolExecuteAfterHook(ctx)
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
    const graphBeforeHook = createGraphToolBeforeHook({
      graphService: graphService || null,
      logger,
      cwd: directory,
    })
    const graphAfterHook = createGraphToolAfterHook({
      graphService: graphService || null,
      logger,
      cwd: directory,
    })
    const graphCommandHook = createGraphCommandEventHook(graphService || null, logger)

    const parentSessionLookup = createParentSessionLookup({ v2, directory, loopService, logger })
    const sessionDirectoryLookup = createSessionDirectoryLookup({ v2, directory, loopService })
    const sessionLoopResolver = createSessionLoopResolver({
      loopService,
      getParentSessionId: parentSessionLookup,
      getSessionDirectory: sessionDirectoryLookup,
      logger,
    })
    const permissionAskHandler = createPermissionAskHandler({ resolver: sessionLoopResolver, logger })

    // Resolves sandbox context for a session by following parent hops until an
    // active sandbox loop is found. Returns null if no sandbox is active for
    // the session or its ancestor.
    async function resolveSandboxForSession(sessionID: string) {
      const resolved = await sessionLoopResolver.resolveActiveLoopForSession(sessionID)
      if (!resolved || !resolved.active || !resolved.sandbox) return null
      if (!sandboxManager) return null
      const active = sandboxManager.getActive(resolved.loopName)
      if (!active) return null
      return { docker: sandboxManager.docker, containerName: active.containerName, hostDir: active.projectDir }
    }

    return {
      getCleanup,
      tool: tools,
      config: createConfigHandler(agents, config.agents, { graphEnabled }),
      'chat.message': async (input, output) => {
        await sessionHooks.onMessage(input, output)
      },
      event: async (input) => {
        const eventInput = input as { event: { type: string; properties?: Record<string, unknown> } }
        if (eventInput.event?.type === 'server.instance.disposed') {
          await cleanup()
          return
        }
        await loopHandler.onEvent(eventInput)
        await sessionHooks.onEvent(eventInput)
        await planCaptureEventHook(eventInput)
        await planApprovalEventHook(eventInput)
        await graphCommandHook(eventInput)
        await busRpcHook(eventInput)
      },
      'tool.execute.before': async (input, output) => {
        const resolved = await sessionLoopResolver.resolveActiveLoopForSession(input.sessionID)
        if (resolved) {
          logger.log(`[tool-before] ${input.tool} callID=${input.callID} session=${input.sessionID} loop=${resolved.loopName} sandbox=${resolved.sandbox ? 'yes' : 'no'}`)
        }
        // Graph hook must run BEFORE sandbox hook to inspect original command
        // Graph hook must also run BEFORE toolExecuteBeforeHook to capture original args
        await graphBeforeHook!(input, output)
        await toolExecuteBeforeHook!(input, output)
        await sandboxBeforeHook!(input, output)
      },
      'tool.execute.after': async (input, output) => {
        const resolved = await sessionLoopResolver.resolveActiveLoopForSession(input.sessionID)
        if (resolved) {
          logger.log(`[tool-after] ${input.tool} callID=${input.callID} output=${output.output?.slice(0, 200)}`)
        }
        await sandboxAfterHook!(input, output)
        await toolExecuteAfterHook!(input, output)
        await graphAfterHook!(input, output)
      },
      'permission.ask': permissionAskHandler,
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
You are in READ-ONLY mode for file system operations. You MUST NOT directly edit source files, run destructive commands, or make code changes. You may only read, search, and analyze the codebase.

Ask clarifying questions during research on scope, intent, or tradeoffs.

After research/design, output a brief intention/goal/approach summary followed immediately by exactly one final plan wrapped with \`<!-- forge-plan:start -->\` and \`<!-- forge-plan:end -->\` markers. The plan must include Objective, Loop Name, Phases, Verification, Decisions, Conventions, and Key Context.

use the \`question\` tool to request execution approval with: "New session", "Execute here", "Loop (worktree)", or "Loop". Never execute without a marked plan and explicit approval via the question tool.
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

  // Register the forge worktree workspace adaptor so worktree-backed loops can be
  // switched to directly from the TUI as workspaces.
  // Guarded in case the host runtime is older than the type declarations.
  const workspaceApi = (input as PluginInput & {
    experimental_workspace?: PluginInput['experimental_workspace']
  }).experimental_workspace
  if (workspaceApi) {
    try {
      workspaceApi.register(FORGE_WORKTREE_WORKSPACE_TYPE, createForgeWorktreeAdaptor())
    } catch {
      // Workspace adaptor registration is optional — silently ignore failures
      // (e.g., duplicate registration, unsupported runtime, older opencode version)
    }
  }

  return hooks
}

const pluginModule = {
  id: 'oc-forge',
  server: plugin,
}

export default pluginModule
export type { PluginConfig, CompactionConfig } from './types'
export { VERSION } from './version'
