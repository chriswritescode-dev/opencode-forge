import type { Plugin, PluginInput, Hooks } from '@opencode-ai/plugin'
import { join } from 'path'
import type { ForgeClient, SessionGetParams } from './client/port'
import { buildAgents } from './agents'
import { createConfigHandler } from './config'
import { createSessionHooks, createLoopEventHandler } from './hooks'
import { initializeDatabase, resolveDataDir, closeDatabase, createLoopsRepo, createPlansRepo, createReviewFindingsRepo, createSectionPlansRepo, createLoopSessionUsageRepo } from './storage'
import type { LoopChangeNotifier } from './loop'
import { loadPluginConfig, resolveBundledContainerDir, resolvePromptsDir } from './setup'
import { resolveLogPath } from './storage'
import { createLogger } from './utils/logger'
import { createDockerService } from './sandbox/docker'
import { defaultGitService } from './utils/git-service'
import { resolveSandboxContextForLoop } from './sandbox/context'
import { createSandboxManager } from './sandbox/manager'
import type { PluginConfig, CompactionConfig } from './types'
import { createTools } from './tools'
import { createToolExecuteBeforeHook, createToolExecuteAfterHook, createPlanApprovalEventHook } from './hooks'
import { createSandboxToolBeforeHook, createSandboxToolAfterHook } from './hooks/sandbox-tools'
import type { ToolContext } from './tools'
import { createForgeClientFromPluginInput } from './client/sdk-adapter'

import { LRUCache } from './utils/lru-cache'
import { createSessionLoopResolver } from './services/session-loop-resolver'
import { createPlanCaptureEventHook } from './hooks/plan-capture'
import { createForgeSessionAttachHook, createForgeSessionMessageAttachHook } from './hooks/forge-session-attach'
import { createLoopPermissionRejectHook } from './hooks/loop-permission'
import { createSandboxMessageHook } from './hooks/sandbox-message'


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

    let sandboxManager: ReturnType<typeof createSandboxManager> | null = null
    const dockerService = createDockerService(logger)
    if (config.sandbox?.enabled === false) {
      logger.log('Docker sandbox disabled via config (sandbox.enabled=false); running in worktree-only mode')
    } else {
      try {
        sandboxManager = createSandboxManager(dockerService, {
          image: config.sandbox?.image ?? 'oc-forge-sandbox:latest',
          dataDir,
          sourceProjectDir: directory,
          mountProjectReadonly: config.sandbox?.mountProjectReadonly,
          projectMountPath: config.sandbox?.projectMountPath,
          ...(config.sandbox?.mounts ? { customMounts: config.sandbox.mounts } : {}),
          buildContextDir: resolveBundledContainerDir(),
          ...(config.sandbox?.resources ? { resources: config.sandbox.resources } : {}),
          ...(config.sandbox?.network ? { network: config.sandbox.network } : {}),
          ...(config.sandbox?.runAsHostUser !== undefined ? { runAsHostUser: config.sandbox.runAsHostUser } : {}),
        }, logger, defaultGitService)
        logger.log('Docker sandbox manager initialized')
      } catch (err) {
        logger.error('Failed to initialize Docker sandbox manager', err)
      }
    }

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
                  message: `Docker image "${sandboxImage}" is missing. Build it from the command palette: "Forge: Build sandbox image", or run: docker build -t ${sandboxImage} "${buildContextDir}"`,
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
      }))
      logger.log(`Registered forge workspace adapter (worktrees under ${join(dataDir, 'worktrees')})`)
    }

    const db = initializeDatabase(dataDir, { completedLoopTtlMs: config.completedLoopTtlMs })

    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const loopSessionUsageRepo = createLoopSessionUsageRepo(db)

    const notifyLoopChange: LoopChangeNotifier = (reason, loopName, hint) => {
      const targetDirectories = Array.from(new Set([
        hint?.projectDir,
        hint?.worktreeDir,
        directory,
      ].filter((dir): dir is string => !!dir)))
      logger.debug(`[notifyLoopChange] reason=${reason} loop=${loopName} dirs=${targetDirectories.join(',')} projectId=${projectId}`)
    }

    const loopHandler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, projectId, forgeClient, logger, () => config, sandboxManager || undefined, dataDir, config.loop, sectionPlansRepo, notifyLoopChange, pendingTeardowns, loopSessionUsageRepo)

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
    const sessionDirectoryLookup = createSessionDirectoryLookup({ client: forgeClient, directory, loop: loopHandler.loop })
    const sessionLoopResolver = createSessionLoopResolver({
      loop: loopHandler.loop,
      getParentSessionId: parentSessionLookup,
      getSessionDirectory: sessionDirectoryLookup,
      logger,
    })
    const loopPermissionRejectHook = createLoopPermissionRejectHook({
      client: forgeClient,
      sessionLoopResolver,
      directory,
      logger,
      getAllowExternalDirectories: () => config.loop?.allowExternalDirectories,
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
      resolveSandboxForSession,
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

    return {
      getCleanup,
      tool: tools,
      config: createConfigHandler(agents, config.agents, promptsDir),
      'chat.message': async (input, output) => {
        await forgeSessionMessageAttachHook(input)
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
        await loopPermissionRejectHook(eventInput)
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
