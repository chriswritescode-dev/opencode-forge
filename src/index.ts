import type { Plugin, PluginInput, Hooks } from '@opencode-ai/plugin'
import { createOpencodeClient as createV2Client } from '@opencode-ai/sdk/v2'
import { agents } from './agents'
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
    const serverPassword = serverUrl.password || process.env['OPENCODE_SERVER_PASSWORD']
    const cleanUrl = new URL(serverUrl.toString())
    cleanUrl.username = ''
    cleanUrl.password = ''
    const v2ClientConfig: Parameters<typeof createV2Client>[0] = { baseUrl: cleanUrl.toString(), directory }
    if (serverPassword) {
      v2ClientConfig.headers = {
        Authorization: `Basic ${Buffer.from(`opencode:${serverPassword}`).toString('base64')}`,
      }
    }
    const v2 = createV2Client(v2ClientConfig)

    const loggingConfig = config.logging
    const logger = createLogger({
      enabled: loggingConfig?.enabled ?? false,
      file: loggingConfig?.file ?? resolveLogPath(),
      debug: loggingConfig?.debug ?? false,
    })
    logger.log(`Initializing plugin for directory: ${directory}, projectId: ${projectId}`)

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

    if (sandboxManager) {
      const preserveLoops = activeSandboxLoops.map(s => s.loopName!).filter(Boolean)
      await sandboxManager.cleanupOrphans(preserveLoops)
      
      // Initial restore for active sandbox loops
      for (const loop of activeSandboxLoops) {
        try {
          await sandboxManager.restore(loop.loopName!, loop.worktreeDir, loop.startedAt)
          loopService.setStatus(loop.loopName!, 'running')
          logger.log(`Restored sandbox and reactivated loop for ${loop.loopName}`)
        } catch (err) {
          logger.error(`Failed to restore sandbox for ${loop.loopName}`, err)
        }
      }

      // Run initial reconciliation
      const reconcileDeps = { sandboxManager, loopService, logger }
      await reconcileSandboxes(reconcileDeps)

      // Start periodic reconciliation (every 2 seconds).
      // Reuse the same deps object so reconcile.ts's WeakMap-based re-entrancy guard works across ticks.
      sandboxReconcileInterval = setInterval(() => {
        reconcileSandboxes(reconcileDeps).catch((err) => {
          logger.error('Sandbox reconciliation failed', err)
        })
      }, 2000)
    }

    const loopHandler = createLoopEventHandler(loopService, client, v2, logger, () => config, sandboxManager || undefined, projectId, dataDir)

    // Initialize graph service if enabled
    const graphEnabled = config.graph?.enabled ?? true
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

        if (sandboxManager) {
          const activeLoops = loopService.listActive()
          for (const state of activeLoops) {
            if (state.sandbox && sandboxManager) {
              try {
                 await sandboxManager.stop(state.loopName!)
                 logger.log(`Cleanup: stopped sandbox for ${state.loopName}`)
               } catch (err) {
                 logger.error(`Cleanup: failed to stop sandbox for ${state.loopName}`, err)
               }
            }
          }
        }

        loopHandler.terminateAll()
        logger.log('Loop: all active loops terminated')
        
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

    const tools = createTools(ctx)
    const toolExecuteBeforeHook = createToolExecuteBeforeHook(ctx)
    const toolExecuteAfterHook = createToolExecuteAfterHook(ctx)
    const planApprovalEventHook = createPlanApprovalEventHook(ctx)
    const sandboxBeforeHook = createSandboxToolBeforeHook({
      loopService,
      sandboxManager,
      logger,
    })
    const sandboxAfterHook = createSandboxToolAfterHook({
      loopService,
      sandboxManager,
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

    // Resolves an active loop state for a session, checking the session itself
    // and its direct parent. Subagent sessions (e.g. the auditor launched via the
    // Task tool) have their own sessionID with a parentID pointing at the loop's
    // primary session; without the parent hop, permission.ask cannot auto-allow
    // for subagents and leaks prompts to the TUI.
    // Bounded LRU avoids unbounded growth across long-running plugin lifetimes;
    // evicted entries are simply re-fetched via session.get on next use.
    const parentSessionCache = new LRUCache<string | null>(500)
    async function resolveActiveLoopForSession(sessionId: string): Promise<ReturnType<typeof loopService.getActiveState>> {
      const directLoopName = loopService.resolveLoopName(sessionId)
      const directState = directLoopName ? loopService.getActiveState(directLoopName) : null
      if (directState?.active) return directState

      let parentId: string | null | undefined = parentSessionCache.has(sessionId)
        ? parentSessionCache.get(sessionId)
        : undefined
      if (parentId === undefined) {
        try {
          const result = await v2.session.get({ sessionID: sessionId, directory })
          parentId = result.data?.parentID ?? null
          parentSessionCache.set(sessionId, parentId)
        } catch (err) {
          logger.debug(`permission.ask: session.get failed for ${sessionId}`, err)
          parentSessionCache.set(sessionId, null)
          return null
        }
      }

      if (!parentId) return null
      const parentLoopName = loopService.resolveLoopName(parentId)
      const parentState = parentLoopName ? loopService.getActiveState(parentLoopName) : null
      return parentState?.active ? parentState : null
    }

    return {
      getCleanup,
      tool: tools,
      config: createConfigHandler(agents, config.agents),
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
        await planApprovalEventHook(eventInput)
        await graphCommandHook(eventInput)
      },
      'tool.execute.before': async (input, output) => {
        const loopName = loopService.resolveLoopName(input.sessionID)
        if (loopName) {
          logger.log(`[tool-before] ${input.tool} callID=${input.callID} session=${input.sessionID} loop=${loopName}`)
        }
        // Graph hook must run BEFORE sandbox hook to inspect original command
        // Graph hook must also run BEFORE toolExecuteBeforeHook to capture original args
        await graphBeforeHook!(input, output)
        await toolExecuteBeforeHook!(input, output)
        await sandboxBeforeHook!(input, output)
      },
      'tool.execute.after': async (input, output) => {
        const loopName = loopService.resolveLoopName(input.sessionID)
        if (loopName) {
          logger.log(`[tool-after] ${input.tool} callID=${input.callID} output=${output.output?.slice(0, 200)}`)
        }
        await sandboxAfterHook!(input, output)
        await toolExecuteAfterHook!(input, output)
        await graphAfterHook!(input, output)
      },
      'permission.ask': async (input, output) => {
        const state = await resolveActiveLoopForSession(input.sessionID)
        if (!state) return

        const patterns = Array.isArray(input.pattern) ? input.pattern : (input.pattern ? [input.pattern] : [])

        if (patterns.some((p) => p.startsWith('git push'))) {
          logger.log(`Loop: denied git push for session ${input.sessionID} (loop ${state.loopName})`)
          output.status = 'deny'
          return
        }

        logger.log(`Loop: auto-allowing ${input.type} [${patterns.join(', ')}] for session ${input.sessionID} (loop ${state.loopName})`)
        output.status = 'allow'
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
You are in READ-ONLY mode for file system operations. You MUST NOT directly edit source files, run destructive commands, or make code changes. You may only read, search, and analyze the codebase.

However, you CAN and SHOULD:
- Use \`plan-write\` to write the plan
- Use \`plan-edit\` to make targeted updates to the plan
- Use \`plan-read\` to review the plan, including by explicit \`loop_name\` when needed
- Use \`plan-execute\` or \`loop\` ONLY AFTER:
  1. The plan has been written via \`plan-write\`
  2. The user explicitly approves via the question tool

Follow the two-step approval flow:
1. After research/design, present findings and next steps, then use the \`question\` tool to ask whether to write the plan
2. Only after the user approves writing the plan, call \`plan-write\` to persist it
3. After the plan is written, present a summary and use the \`question\` tool to collect execution approval with the four canonical options

Never execute a plan without both a written plan and explicit approval via the question tool.
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
    } catch (err) {
      console.error('Failed to register forge worktree workspace adaptor', err)
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
