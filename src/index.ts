import type { Plugin, PluginInput, Hooks } from '@opencode-ai/plugin'
import { createOpencodeClient as createV2Client } from '@opencode-ai/sdk/v2'
import { agents } from './agents'
import { createConfigHandler } from './config'
import { createSessionHooks, createLoopEventHandler } from './hooks'
import { initializeDatabase, resolveDataDir, closeDatabase } from './storage'
import { createKvService } from './services/kv'
import { createLoopService, migrateRalphKeys } from './services/loop'
import { createGraphService } from './graph'
import { loadPluginConfig } from './setup'
import { resolveLogPath } from './storage'
import { createLogger } from './utils/logger'
import { createDockerService } from './sandbox/docker'
import { createSandboxManager } from './sandbox/manager'
import type { PluginConfig, CompactionConfig } from './types'
import { createTools, createToolExecuteBeforeHook, createToolExecuteAfterHook, createPlanApprovalEventHook } from './tools'
import { createSandboxToolBeforeHook, createSandboxToolAfterHook } from './hooks/sandbox-tools'
import { createGraphCommandEventHook } from './hooks/graph-command'
import { createGraphToolBeforeHook, createGraphToolAfterHook } from './hooks/graph-tools'
import type { ToolContext } from './tools'
import type { GraphService } from './graph'
import { createGraphStatusCallback, writeGraphStatus, UNAVAILABLE_STATUS } from './utils/graph-status-store'


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

    const dataDir = config.dataDir ?? resolveDataDir()
    
    const db = initializeDatabase(dataDir)

    const kvService = createKvService(db, logger, config.defaultKvTtlMs)

    const loopService = createLoopService(kvService, projectId, logger, config.loop)
    try {
      migrateRalphKeys(kvService, projectId, logger)
    } catch (err) {
      logger.error('Failed to migrate ralph: KV entries', err)
    }

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

    if (sandboxManager) {
      const preserveLoops = activeSandboxLoops.map(s => s.loopName!).filter(Boolean)
      sandboxManager.cleanupOrphans(preserveLoops).then(async (count) => {
        if (count > 0) logger.log(`Cleaned up ${count} orphaned sandbox container(s)`)
        for (const loop of activeSandboxLoops) {
          try {
            await sandboxManager!.restore(loop.loopName!, loop.worktreeDir, loop.startedAt)
            loopService.setState(loop.loopName!, { ...loop, active: true })
            logger.log(`Restored sandbox and reactivated loop for ${loop.loopName}`)
          } catch (err) {
            logger.error(`Failed to restore sandbox for ${loop.loopName}`, err)
          }
        }
      }).catch((err) => logger.error('Failed to cleanup orphaned containers', err))
    }

    const loopHandler = createLoopEventHandler(loopService, client, v2, logger, () => config, sandboxManager || undefined, projectId, dataDir)

    // Initialize graph service if enabled
    const graphEnabled = config.graph?.enabled ?? true
    let graphService: GraphService | null = null
    
    if (graphEnabled) {
      try {
        // Create status callback for persisting graph state (scoped to cwd for worktree sessions)
        const graphStatusCallback = createGraphStatusCallback(kvService, projectId, directory)
        
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
          graphService.ensureStartupIndex().catch((err) => {
            logger.error('Graph startup index check failed', err)
          })
        }
      } catch (err) {
        logger.error('Failed to initialize graph service', err)
        graphService = null
      }
    } else {
      // Graph is disabled - persist unavailable status
      writeGraphStatus(kvService, projectId, UNAVAILABLE_STATUS)
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
      kvService,
      loopService,
      loopHandler,
      v2,
      cleanup,
      input,
      sandboxManager,
      graphService: graphService || null,
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

    return {
      getCleanup,
      tool: tools,
      config: createConfigHandler(
        config.auditorModel
          ? { ...agents, auditor: { ...agents.auditor, defaultModel: config.auditorModel } }
          : agents,
        config.agents
      ),
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
        const loopName = loopService.resolveLoopName(input.sessionID)
        const state = loopName ? loopService.getActiveState(loopName) : null
        if (!state?.active) return

        const patterns = Array.isArray(input.pattern) ? input.pattern : (input.pattern ? [input.pattern] : [])

        if (patterns.some((p) => p.startsWith('git push'))) {
          logger.log(`Loop: denied git push for session ${input.sessionID}`)
          output.status = 'deny'
          return
        }

        logger.log(`Loop: auto-allowing ${input.type} [${patterns.join(', ')}] for session ${input.sessionID}`)
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
  return factory(input)
}

const pluginModule = {
  id: 'oc-forge',
  server: plugin,
}

export default pluginModule
export type { PluginConfig, CompactionConfig } from './types'
export { VERSION } from './version'
