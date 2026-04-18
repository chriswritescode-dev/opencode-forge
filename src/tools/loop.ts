import { tool } from '@opencode-ai/plugin'
import { execSync, spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import type { ToolContext } from './types'

import { parseModelString, retryWithModelFallback } from '../utils/model-fallback'
import { slugify } from '../utils/logger'
import { findPartialMatch } from '../utils/partial-match'
import { formatSessionOutput, formatAuditResult } from '../utils/loop-format'
import { fetchSessionOutput, MAX_RETRIES, buildCompletionSignalInstructions, DEFAULT_COMPLETION_SIGNAL, type LoopState, type LoopSessionOutput } from '../services/loop'
import { buildLoopPermissionRuleset } from '../constants/loop'
import { resolveWorktreeLogTarget } from '../services/worktree-log'
import { agents } from '../agents'
import { isSandboxEnabled } from '../sandbox/context'
import { formatDuration, computeElapsedSeconds } from '../utils/loop-helpers'
import { waitForGraphReady } from '../utils/tui-graph-status'
import { createLoopWorkspace, bindSessionToWorkspace } from '../workspace/forge-worktree'

const z = tool.schema

interface LoopSetupOptions {
  prompt: string
  sessionTitle: string
  loopName: string
  sourcePlanSessionID?: string
  completionSignal: string | null
  maxIterations: number
  audit: boolean
  agent?: string
  model?: { providerID: string; modelID: string }
  worktree?: boolean
  executionModel?: string
  auditorModel?: string
  onLoopStarted?: (loopName: string) => void
}

export async function setupLoop(
  ctx: ToolContext,
  options: LoopSetupOptions,
): Promise<string> {
  const { v2, directory, config, loopService, logger, sandboxManager, plansRepo, projectId } = ctx
  const projectDir = directory
  const maxIter = options.maxIterations ?? config.loop?.defaultMaxIterations ?? 0
  
  const uniqueLoopName = loopService.generateUniqueLoopName(options.loopName)

  interface LoopContext {
    sessionId: string
    directory: string
    branch?: string
    worktree: boolean
    workspaceId?: string
  }

  let loopContext: LoopContext

  if (!options.worktree) {
    // Non-worktree: resolve log target using project directory
    // Note: In-place loops may still need log directory access if they write logs directly
    const logTarget = resolveWorktreeLogTarget(config, {
      projectDir: projectDir,
      sandboxHostDir: undefined,
      sandbox: false,
      dataDir: ctx.dataDir,
    }, ctx.logger)
    const agentExclusions = agents.code.tools?.exclude
    const permissionRuleset = buildLoopPermissionRuleset(config, logTarget?.permissionPath ?? null, {
      isWorktree: false,
      agentExclusions,
    })

    let currentBranch: string | undefined
    try {
      currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: projectDir, encoding: 'utf-8' }).trim()
    } catch (_err) {
      logger.log(`loop: no git branch detected, running without branch info`)
    }

    const createResult = await v2.session.create({
      title: options.sessionTitle,
      directory: projectDir,
      permission: permissionRuleset,
    })

    if (createResult.error || !createResult.data) {
      logger.error(`loop: failed to create session`, createResult.error)
      return 'Failed to create loop session.'
    }

    loopContext = {
      sessionId: createResult.data.id,
      directory: projectDir,
      branch: currentBranch,
      worktree: false,
    }
  } else {
    // Worktree mode: create worktree first to get the actual directory
    const worktreeResult = await v2.worktree.create({
      worktreeCreateInput: { name: uniqueLoopName },
    })

    if (worktreeResult.error || !worktreeResult.data) {
      logger.error(`loop: failed to create worktree`, worktreeResult.error)
      return 'Failed to create worktree.'
    }

    const worktreeInfo = worktreeResult.data
    logger.log(`loop: worktree created at ${worktreeInfo.directory} (branch: ${worktreeInfo.branch})`)

    // Seed graph cache from source repo to worktree scope before session creation
    const seedResult = await (async () => {
      try {
        const { seedWorktreeGraphScope } = await import('../utils/worktree-graph-seed')
        return await seedWorktreeGraphScope({
          projectId: ctx.projectId,
          sourceCwd: projectDir,
          targetCwd: worktreeInfo.directory,
          dataDir: ctx.dataDir,
          graphStatusRepo: ctx.graphStatusRepo,
          logger,
        })
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        logger.log(`loop: graph seed error (non-fatal): ${reason}`)
        return { seeded: false, reason }
      }
    })()
    logger.log(`loop: graph seed ${seedResult.seeded ? 'reused' : 'skipped'} (${seedResult.reason})`)

    // Worktree sessions no longer need log directory access since logging is dispatched via host session
    // Only resolve log target for non-worktree sessions or if needed for other purposes
    const agentExclusions = agents.code.tools?.exclude
    const permissionRuleset = buildLoopPermissionRuleset(config, null, {
      isWorktree: true,
      agentExclusions,
    })

    const createResult = await v2.session.create({
      title: options.sessionTitle,
      directory: worktreeInfo.directory,
      permission: permissionRuleset,
    })

    if (createResult.error || !createResult.data) {
      logger.error(`loop: failed to create session`, createResult.error)
      try {
        await v2.worktree.remove({ worktreeRemoveInput: { directory: worktreeInfo.directory } })
        // Delete graph cache for this worktree scope on startup failure
        const { deleteGraphCacheScope } = await import('../storage/graph-projects')
        const deleted = deleteGraphCacheScope(ctx.projectId, worktreeInfo.directory, ctx.dataDir)
        if (deleted) {
          logger.log(`loop: deleted graph cache for worktree ${worktreeInfo.directory}`)
        }
      } catch (cleanupErr) {
        logger.error(`loop: failed to cleanup worktree`, cleanupErr)
      }
      return 'Failed to create loop session.'
    }

    loopContext = {
      sessionId: createResult.data.id,
      directory: worktreeInfo.directory,
      branch: worktreeInfo.branch,
      worktree: true,
    }

    // Optionally create a workspace and bind the session so the worktree loop
    // can be switched to directly from the TUI. If the host runtime doesn't
    // expose experimental_workspace, the loop continues without workspace
    // backing — the user just can't switch via the workspace UI.
    const workspace = await createLoopWorkspace(v2, {
      loopName: uniqueLoopName,
      directory: worktreeInfo.directory,
      branch: worktreeInfo.branch,
    })

    if (workspace) {
      loopContext.workspaceId = workspace.workspaceId
      try {
        await bindSessionToWorkspace(v2, workspace.workspaceId, loopContext.sessionId)
        logger.log(`loop: workspace ${workspace.workspaceId} bound to session ${loopContext.sessionId}`)
      } catch (bindErr) {
        logger.error('loop: failed to bind session to workspace; continuing without workspace backing', bindErr)
        loopContext.workspaceId = undefined
      }
    } else {
      logger.log(`loop: workspace API unavailable or create failed; continuing without workspace backing for ${uniqueLoopName}`)
    }
  }

  let sandboxContainer: string | undefined
  const sandboxEnabled = isSandboxEnabled(config, sandboxManager) && !!options.worktree

  if (sandboxEnabled) {
    try {
      const result = await sandboxManager!.start(uniqueLoopName, loopContext.directory)
      sandboxContainer = result.containerName
      logger.log(`Sandbox container ${sandboxContainer} started for loop ${uniqueLoopName}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`loop: failed to start sandbox container`, err)
      return `Failed to start sandbox container: ${message}`
    }
  }

  const state: LoopState = {
    active: true,
    sessionId: loopContext.sessionId,
    loopName: uniqueLoopName,
    worktreeDir: loopContext.directory,
    projectDir: projectDir,
    worktreeBranch: loopContext.branch,
    iteration: 1,
    maxIterations: maxIter,
    completionSignal: options.completionSignal,
    startedAt: new Date().toISOString(),
    prompt: options.prompt,
    phase: 'coding',
    audit: true,
    errorCount: 0,
    auditCount: 0,
    worktree: options.worktree,
    sandbox: sandboxEnabled,
    sandboxContainer,
    executionModel: options.executionModel,
    auditorModel: options.auditorModel,
    workspaceId: options.worktree ? loopContext.workspaceId : undefined,
  }

  // Plan is persisted into loop_large_fields.prompt by loopService.setState below.
  // Clean up the draft entry in the plans table if a sourcePlanSessionID was passed.
  if (options.sourcePlanSessionID) {
    plansRepo.deleteForSession(projectId, options.sourcePlanSessionID)
  }

  loopService.setState(uniqueLoopName, state)
  loopService.registerLoopSession(loopContext.sessionId, uniqueLoopName)
  logger.log(`loop: state stored for loop=${uniqueLoopName}`)

  // Wait for worktree graph to be ready before first prompt (only for worktree mode)
  if (options.worktree) {
    try {
      const waitResult = await waitForGraphReady(projectId, {
        cwd: loopContext.directory,
        dbPathOverride: ctx.dataDir ? join(ctx.dataDir, 'graph.db') : undefined,
        pollMs: 100,
        timeoutMs: 5000,
      })
      
      if (waitResult === 'timeout') {
        logger.log(`setupLoop: graph readiness timeout for worktree ${loopContext.directory}`)
      } else if (waitResult === null) {
        logger.log(`setupLoop: graph status unavailable for worktree ${loopContext.directory}`)
      } else {
        logger.log(`setupLoop: graph ready (${waitResult.state}) for worktree ${loopContext.directory}`)
      }
    } catch (err) {
      // Non-fatal: continue even if wait fails
      logger.log(`setupLoop: graph wait error (non-fatal)`, err)
    }
  }

  let promptText = options.prompt
  if (options.completionSignal) {
    promptText += buildCompletionSignalInstructions(options.completionSignal)
  }

  const { result: promptResult, usedModel: actualModel } = await retryWithModelFallback(
    () => v2.session.promptAsync({
      sessionID: loopContext.sessionId,
      directory: loopContext.directory,
      parts: [{ type: 'text' as const, text: promptText }],
      ...(options.agent && { agent: options.agent }),
      model: options.model!,
    }),
    () => v2.session.promptAsync({
      sessionID: loopContext.sessionId,
      directory: loopContext.directory,
      parts: [{ type: 'text' as const, text: promptText }],
      ...(options.agent && { agent: options.agent }),
    }),
    options.model,
    logger,
  )

  if (promptResult.error) {
    logger.error(`loop: failed to send prompt`, promptResult.error)
    loopService.deleteState(uniqueLoopName)
    if (sandboxEnabled) {
      try {
        await sandboxManager!.stop(uniqueLoopName)
      } catch (sbxErr) {
        logger.error(`loop: failed to stop sandbox container on prompt failure`, sbxErr)
      }
    }
    if (options.worktree) {
      try {
        await v2.worktree.remove({ worktreeRemoveInput: { directory: loopContext.directory } })
        // Delete graph cache for this worktree scope on startup failure
        const { deleteGraphCacheScope } = await import('../storage/graph-projects')
        const deleted = deleteGraphCacheScope(ctx.projectId, loopContext.directory, ctx.dataDir)
        if (deleted) {
          logger.log(`loop: deleted graph cache for worktree ${loopContext.directory}`)
        }
      } catch (cleanupErr) {
        logger.error(`loop: failed to cleanup worktree`, cleanupErr)
      }
    }
    return !options.worktree
      ? 'Loop session created but failed to send prompt.'
      : 'Loop session created but failed to send prompt. Cleaned up.'
  }

  options.onLoopStarted?.(uniqueLoopName)

  // Navigate TUI to the new session for both worktree and non-worktree loops.
  // Worktree loops are workspace-backed, so selectSession works across workspaces.
  v2.tui.selectSession({ sessionID: loopContext.sessionId }).catch((err) => {
    logger.error('loop: failed to navigate TUI to new session', err)
  })

  const maxInfo = maxIter > 0 ? maxIter.toString() : 'unlimited'
  const auditInfo = options.audit ? 'enabled' : 'disabled'
  const modelInfo = actualModel ? `${actualModel.providerID}/${actualModel.modelID}` : 'default'

  const lines: string[] = [
    !options.worktree ? 'Memory loop activated! (in-place mode)' : 'Memory loop activated!',
    '',
    `Session: ${loopContext.sessionId}`,
    `Title: ${options.sessionTitle}`,
  ]

  if (!options.worktree) {
    lines.push(`Directory: ${loopContext.directory}`)
    if (loopContext.branch) {
      lines.push(`Branch: ${loopContext.branch} (in-place)`)
    }
  } else {
    lines.push(`Loop name: ${uniqueLoopName}`)
    lines.push(`Worktree: ${loopContext.directory}`)
    lines.push(`Branch: ${loopContext.branch}`)
  }

  lines.push(
    `Model: ${modelInfo}`,
    `Max iterations: ${maxInfo}`,
    `Completion promise: ${options.completionSignal ?? 'none'}`,
    `Audit: ${auditInfo}`,
    '',
    'The loop will automatically continue when the session goes idle.',
    'Your job is done — just confirm to the user that the loop has been launched.',
    'The user can run loop-status or loop-cancel later if needed.',
  )

  return lines.join('\n')
}

export function createLoopTools(ctx: ToolContext): Record<string, ReturnType<typeof tool>> {
  const { v2, loopService, loopHandler, config, logger } = ctx

  return {
    loop: tool({
      description: 'Execute a plan using an iterative development loop. Default runs in current directory. Set worktree to true for isolated git worktree.',
      args: {
        plan: z.string().optional().describe('The full implementation plan. If omitted, reads from the session plan store.'),
        title: z.string().describe('Short title for the session (shown in session list)'),
        worktree: z.boolean().optional().default(false).describe('Run in isolated git worktree instead of current directory'),
        loopName: z.string().optional().describe('Name for the loop (max 25 chars, auto-incremented if collision exists)'),
      },
      execute: async (args, context) => {
        if (config.loop?.enabled === false) {
          return 'Loops are disabled in plugin config. Use plan-execute instead.'
        }

        logger.log(`loop: creating worktree for plan="${args.title}"`)

        let planText = args.plan
        let sourcePlanSessionID: string | undefined
        if (!planText) {
          const planRow = ctx.plansRepo.getForSession(ctx.projectId, context.sessionID)
          if (!planRow) {
            return 'No plan found. Write the plan via plan-write before calling this tool, or pass it directly as the plan argument.'
          }
          planText = planRow.content
          sourcePlanSessionID = context.sessionID
        }

        const sessionTitle = args.title.length > 60 ? `${args.title.substring(0, 57)}...` : args.title
        const loopModel = parseModelString(config.loop?.model) ?? parseModelString(config.executionModel)
        const audit = true
        const executionModel = config.loop?.model ?? config.executionModel
        const auditorModel = config.auditorModel ?? config.loop?.model ?? config.executionModel
        
        const loopName = args.loopName ? slugify(args.loopName) : slugify(sessionTitle)

        return setupLoop(ctx, {
          prompt: planText,
          sessionTitle: `Loop: ${sessionTitle}`,
          loopName,
          sourcePlanSessionID,
          completionSignal: DEFAULT_COMPLETION_SIGNAL,
          maxIterations: config.loop?.defaultMaxIterations ?? 0,
          audit: audit,
          agent: 'code',
          model: loopModel,
          worktree: args.worktree,
          executionModel: executionModel,
          auditorModel: auditorModel,
          onLoopStarted: (id) => loopHandler.startWatchdog(id),
        })
      },
    }),

    'loop-cancel': tool({
      description: 'Cancels the only active loop when called with no arguments. Pass a name to cancel a specific loop.',
      args: {
        name: z.string().optional().describe('Worktree name of the loop to cancel'),
      },
      execute: async (args) => {
        let state: LoopState

        if (args.name) {
          const name = args.name
          const { match, candidates } = loopService.findMatchByName(name)
          if (!match) {
            if (candidates.length > 0) {
              return `Multiple loops match "${name}":\n${candidates.map((s) => `- ${s.loopName}`).join('\n')}\n\nBe more specific.`
            }
            const recent = loopService.listRecent()
            const foundRecent = recent.find((s) => s.loopName === name || (s.worktreeBranch && s.worktreeBranch.toLowerCase().includes(name.toLowerCase())))
            if (foundRecent) {
               return `Loop "${foundRecent.loopName}" has already completed.`
            }
             return `No active loop found for loop "${name}".`
          }
          state = match
          if (!state.active) {
             return `Loop "${state.loopName}" has already completed.`
          }
        } else {
          const active = loopService.listActive()
           if (active.length === 0) return 'No active loops.'
          if (active.length === 1) {
            state = active[0]
          } else {
             return `Multiple active loops. Specify a name:\n${active.map((s) => `- ${s.loopName} (iteration ${s.iteration})`).join('\n')}`
          }
        }

        await loopHandler.cancelBySessionId(state.sessionId)
        logger.log(`loop-cancel: cancelled loop for session=${state.sessionId} at iteration ${state.iteration}`)

        if (config.loop?.cleanupWorktree && state.worktree && state.worktreeDir) {
          try {
            const gitCommonDir = execSync('git rev-parse --git-common-dir', { cwd: state.worktreeDir, encoding: 'utf-8' }).trim()
            const gitRoot = resolve(state.worktreeDir, gitCommonDir, '..')
            const removeResult = spawnSync('git', ['worktree', 'remove', '-f', state.worktreeDir], { cwd: gitRoot, encoding: 'utf-8' })
            if (removeResult.status !== 0) {
              throw new Error(removeResult.stderr || 'git worktree remove failed')
            }
            logger.log(`loop-cancel: removed worktree ${state.worktreeDir}`)
            
            // Delete graph cache for this worktree scope
            const { deleteGraphCacheScope } = await import('../storage/graph-projects')
            const deleted = deleteGraphCacheScope(ctx.projectId, state.worktreeDir, ctx.dataDir)
            if (deleted) {
              logger.log(`loop-cancel: deleted graph cache for worktree ${state.worktreeDir}`)
            }
          } catch (err) {
            logger.error(`loop-cancel: failed to remove worktree`, err)
          }
        }

        const modeInfo = !state.worktree ? ' (in-place)' : ''
        const branchInfo = state.worktreeBranch ? `\nBranch: ${state.worktreeBranch}` : ''
        return `Cancelled loop "${state.loopName}"${modeInfo} (was at iteration ${state.iteration}).\nDirectory: ${state.worktreeDir}${branchInfo}`
      },
    }),

    'loop-status': tool({
      description: 'Lists all active loops when called with no arguments. Pass a worktree name for detailed status of a specific loop. Use restart to resume an inactive loop. Use restart with force to force-restart a stuck active loop.',
      args: {
        name: z.string().optional().describe('Worktree name to check for detailed status'),
        restart: z.boolean().optional().default(false).describe('Restart an inactive loop by name'),
        force: z.boolean().optional().default(false).describe('Force restart an active/stuck loop'),
      },
      execute: async (args) => {
        const active = loopService.listActive()

        if (args.restart) {
          if (!args.name) {
            return 'Specify a loop name to restart. Use loop-status to see available loops.'
          }

          const recent = loopService.listRecent()
          const allStates = [...active, ...recent]
          const { match: stoppedState, candidates } = findPartialMatch(args.name, allStates, (s) => [s.loopName, s.worktreeBranch])
          if (!stoppedState && candidates.length > 0) {
            return `Multiple loops match "${args.name}":\n${candidates.map((s) => `- ${s.loopName}`).join('\n')}\n\nBe more specific.`
          }
          if (!stoppedState) {
            const available = [...active, ...recent].map((s) => `- ${s.loopName}`).join('\n')
             return `No loop found for "${args.name}".\n\nAvailable loops:\n${available}`
          }

          if (stoppedState.active) {
            if (!args.force) {
              return `Loop "${stoppedState.loopName}" is currently active. Use restart with force: true to force-restart a stuck loop.`
            }
            try { await v2.session.abort({ sessionID: stoppedState.sessionId }) } catch {}
            loopService.unregisterLoopSession(stoppedState.sessionId)
          }

          if (stoppedState.terminationReason === 'completed') {
            return `Loop "${stoppedState.loopName}" completed successfully and cannot be restarted.`
          }

          if (!stoppedState.worktree && stoppedState.worktreeDir) {
            if (!existsSync(stoppedState.worktreeDir)) {
              return `Cannot restart "${stoppedState.loopName}": worktree directory no longer exists at ${stoppedState.worktreeDir}. The worktree may have been cleaned up.`
            }
          }

          // Worktree sessions no longer need log directory access since logging is dispatched via host session
          const agentExclusions = agents.code.tools?.exclude
          const permissionRuleset = buildLoopPermissionRuleset(config, null, {
            isWorktree: !!stoppedState.worktree,
            agentExclusions,
          })

          const createParams = {
            title: stoppedState.loopName,
            directory: stoppedState.worktreeDir!,
            permission: permissionRuleset,
          }

          const createResult = await v2.session.create(createParams)

          if (createResult.error || !createResult.data) {
             logger.error(`loop-restart: failed to create session`, createResult.error)
            return `Failed to create new session for restart.`
          }

          const newSessionId = createResult.data.id

          loopService.deleteState(stoppedState.loopName!)

          const restartSandbox = isSandboxEnabled(config, ctx.sandboxManager)
          if (restartSandbox) {
            try {
              const sbxResult = await ctx.sandboxManager!.start(stoppedState.loopName!, stoppedState.worktreeDir!)
               logger.log(`loop-restart: started sandbox container ${sbxResult.containerName}`)
            } catch (err) {
               logger.error(`loop-restart: failed to start sandbox container`, err)
              return `Restart failed: could not start sandbox container.`
            }
          }

          const newState: LoopState = {
            active: true,
            sessionId: newSessionId,
            loopName: stoppedState.loopName,
            worktreeDir: stoppedState.worktreeDir!,
            projectDir: stoppedState.projectDir || stoppedState.worktreeDir!,
            worktreeBranch: stoppedState.worktreeBranch,
            iteration: stoppedState.iteration!,
            maxIterations: stoppedState.maxIterations!,
            completionSignal: stoppedState.completionSignal,
            startedAt: new Date().toISOString(),
            prompt: stoppedState.prompt,
            phase: 'coding',
            audit: stoppedState.audit,
            errorCount: 0,
            auditCount: 0,
            worktree: stoppedState.worktree,
            sandbox: restartSandbox,
            sandboxContainer: restartSandbox
                ? ctx.sandboxManager?.docker.containerName(stoppedState.loopName!)
                : undefined,
            executionModel: stoppedState.executionModel,
            auditorModel: stoppedState.auditorModel,
          }

          loopService.setState(stoppedState.loopName!, newState)
          loopService.registerLoopSession(newSessionId, stoppedState.loopName!)

          let promptText = stoppedState.prompt ?? ''
          if (stoppedState.completionSignal) {
            promptText += buildCompletionSignalInstructions(stoppedState.completionSignal)
          }

          const loopModel = parseModelString(stoppedState.executionModel)
            ?? parseModelString(config.loop?.model)
            ?? parseModelString(config.executionModel)

          const { result: promptResult } = await retryWithModelFallback(
            () => v2.session.promptAsync({
              sessionID: newSessionId,
              directory: stoppedState.worktreeDir!,
              parts: [{ type: 'text' as const, text: promptText }],
              agent: 'code',
              model: loopModel!,
            }),
            () => v2.session.promptAsync({
              sessionID: newSessionId,
              directory: stoppedState.worktreeDir!,
              parts: [{ type: 'text' as const, text: promptText }],
              agent: 'code',
            }),
            loopModel,
            logger,
          )

          if (promptResult.error) {
             logger.error(`loop-restart: failed to send prompt`, promptResult.error)
            loopService.deleteState(stoppedState.loopName!)
            if (restartSandbox) {
              try {
                await ctx.sandboxManager!.stop(stoppedState.loopName!)
              } catch (sbxErr) {
                 logger.error(`loop-restart: failed to stop sandbox on prompt failure`, sbxErr)
              }
            }
            return `Restart failed: could not send prompt to new session.`
          }

          loopHandler.startWatchdog(stoppedState.loopName!)

          const modeInfo = !stoppedState.worktree ? ' (in-place)' : ''
          const branchInfo = stoppedState.worktreeBranch ? `\nBranch: ${stoppedState.worktreeBranch}` : ''
          return [
            `Restarted loop "${stoppedState.loopName}"${modeInfo}`,
            '',
            `New session: ${newSessionId}`,
            `Continuing from iteration: ${stoppedState.iteration}`,
            `Previous termination: ${stoppedState.terminationReason}`,
            `Directory: ${stoppedState.worktreeDir}${branchInfo}`,
            `Audit: ${stoppedState.audit ? 'enabled' : 'disabled'}`,
          ].join('\n')
        }

        if (!args.name) {
          const recent = loopService.listRecent()

          if (active.length === 0) {
            if (recent.length === 0) return 'No loops found.'

            const lines: string[] = ['Recently Completed Loops', '']
            recent.forEach((s, i) => {
              const durationStr = formatDuration(computeElapsedSeconds(s.startedAt, s.completedAt))
              lines.push(`${i + 1}. ${s.loopName}`)
              lines.push(`   Reason: ${s.terminationReason ?? 'unknown'} | Iterations: ${s.iteration} | Duration: ${durationStr} | Completed: ${s.completedAt ?? 'unknown'}`)
              lines.push('')
            })
            lines.push('Use loop-status <name> for detailed info.')
            return lines.join('\n')
          }

          const statuses: Record<string, { type: string; attempt?: number; message?: string; next?: number }> = {}
          try {
            const uniqueDirs = [...new Set(active.map((s) => s.worktreeDir).filter(Boolean))]
            const results = await Promise.allSettled(
              uniqueDirs.map((dir) => v2.session.status({ directory: dir })),
            )
            for (const result of results) {
              if (result.status === 'fulfilled' && result.value.data) {
                Object.assign(statuses, result.value.data)
              }
            }
          } catch {
          }

          const lines: string[] = [`Active Loops (${active.length})`, '']
          active.forEach((s, i) => {
            const duration = formatDuration(computeElapsedSeconds(s.startedAt))
            const iterInfo = s.maxIterations && s.maxIterations > 0 ? `${s.iteration} / ${s.maxIterations}` : `${s.iteration} (unlimited)`
            const sessionStatus = statuses[s.sessionId]?.type ?? 'unavailable'
            const modeIndicator = !s.worktree ? ' (in-place)' : ''
            const stallInfo = loopHandler.getStallInfo(s.loopName!)
            const stallCount = stallInfo?.consecutiveStalls ?? 0
            const stallSuffix = stallCount > 0 ? ` | Stalls: ${stallCount}` : ''
            lines.push(`${i + 1}. ${s.loopName}${modeIndicator}`)
            lines.push(`   Phase: ${s.phase} | Iteration: ${iterInfo} | Duration: ${duration} | Status: ${sessionStatus}${stallSuffix}`)
            lines.push('')
          })

          if (recent.length > 0) {
            lines.push('Recently Completed:')
            lines.push('')
            const limitedRecent = recent.slice(0, 10)
            limitedRecent.forEach((s, i) => {
              const durationStr = formatDuration(computeElapsedSeconds(s.startedAt, s.completedAt))
              lines.push(`${i + 1}. ${s.loopName}`)
              lines.push(`   Reason: ${s.terminationReason ?? 'unknown'} | Iterations: ${s.iteration} | Duration: ${durationStr} | Completed: ${s.completedAt ?? 'unknown'}`)
              lines.push('')
            })
            if (recent.length > 10) {
              lines.push(`   ... and ${recent.length - 10} more. Use loop-status <name> for details.`)
              lines.push('')
            }
          }

          lines.push('Use loop-status <name> for detailed info, or loop-cancel <name> to stop a loop.')
          return lines.join('\n')
        }

        const { match: state, candidates } = loopService.findMatchByName(args.name)
        if (!state) {
          if (candidates.length > 0) {
            return `Multiple loops match "${args.name}":\n${candidates.map((s) => `- ${s.loopName}`).join('\n')}\n\nBe more specific.`
          }
          return `No loop found for loop "${args.name}".`
        }

        if (!state.active) {
          const maxInfo = state.maxIterations && state.maxIterations > 0 ? `${state.iteration} / ${state.maxIterations}` : `${state.iteration} (unlimited)`
          const durationStr = formatDuration(computeElapsedSeconds(state.startedAt, state.completedAt))

          const statusLines: string[] = [
            'Loop Status (Inactive)',
            '',
            `Name: ${state.loopName}`,
            `Session: ${state.sessionId}`,
          ]
          if (!state.worktree) {
            statusLines.push(`Mode: in-place | Directory: ${state.worktreeDir}`)
          } else {
            statusLines.push(`Worktree: ${state.worktreeDir}`)
          }
          statusLines.push(
            `Iteration: ${maxInfo}`,
            `Duration: ${durationStr}`,
            `Reason: ${state.terminationReason ?? 'unknown'}`,
          )
          if (state.worktreeBranch) {
            statusLines.push(`Branch: ${state.worktreeBranch}`)
          }
          statusLines.push(
            `Started: ${state.startedAt}`,
            ...(state.completedAt ? [`Completed: ${state.completedAt}`] : []),
          )
          statusLines.push(
            `Model: ${state.executionModel ?? config.loop?.model ?? config.executionModel ?? 'default'}`,
            `Auditor model: ${state.auditorModel ?? config.auditorModel ?? state.executionModel ?? config.loop?.model ?? config.executionModel ?? 'default'}`,
          )

          if (state.lastAuditResult) {
            statusLines.push(...formatAuditResult(state.lastAuditResult))
          }

          const sessionOutput = state.worktreeDir ? await fetchSessionOutput(v2, state.sessionId, state.worktreeDir, logger) : null
          if (sessionOutput) {
            statusLines.push('')
            statusLines.push('Session Output:')
            statusLines.push(...formatSessionOutput(sessionOutput))
          }

          return statusLines.join('\n')
        }

        const maxInfo = state.maxIterations && state.maxIterations > 0 ? `${state.iteration} / ${state.maxIterations}` : `${state.iteration} (unlimited)`
        const promptPreview = state.prompt && state.prompt.length > 100 ? `${state.prompt.substring(0, 97)}...` : (state.prompt ?? '')

        let sessionStatus = 'unknown'
        try {
          const statusResult = await v2.session.status({ directory: state.worktreeDir })
          const statuses = statusResult.data as Record<string, { type: string; attempt?: number; message?: string; next?: number }> | undefined
          const status = statuses?.[state.sessionId]
          if (status) {
            sessionStatus = status.type === 'retry'
              ? `retry (attempt ${status.attempt}, next in ${Math.round(((status.next ?? 0) - Date.now()) / 1000)}s)`
              : status.type
          }
        } catch {
          sessionStatus = 'unavailable'
        }

        const duration = formatDuration(computeElapsedSeconds(state.startedAt))

        const stallInfo = loopHandler.getStallInfo(state.loopName!)
        const secondsSinceActivity = stallInfo
          ? Math.round((Date.now() - stallInfo.lastActivityTime) / 1000)
          : null
        const stallCount = stallInfo?.consecutiveStalls ?? 0

        const statusLines: string[] = [
          'Loop Status',
          '',
          `Name: ${state.loopName}`,
          `Session: ${state.sessionId}`,
        ]
        if (!state.worktree) {
          statusLines.push(`Mode: in-place | Directory: ${state.worktreeDir}`)
        } else {
          statusLines.push(`Worktree: ${state.worktreeDir}`)
        }
        statusLines.push(
          `Status: ${sessionStatus}`,
          `Phase: ${state.phase}`,
          `Iteration: ${maxInfo}`,
          `Duration: ${duration}`,
          `Audit: ${state.audit ? 'enabled' : 'disabled'}`,
        )
        if (state.worktreeBranch) {
          statusLines.push(`Branch: ${state.worktreeBranch}`)
        }

        let sessionOutput: LoopSessionOutput | null = null
        if (state.worktreeDir) {
          try {
            sessionOutput = await fetchSessionOutput(v2, state.sessionId, state.worktreeDir, logger)
          } catch {
            // Silently ignore fetch errors to avoid cluttering output
          }
        }
        if (sessionOutput) {
          statusLines.push('')
          statusLines.push('Session Output:')
          statusLines.push(...formatSessionOutput(sessionOutput))
        }

        if (state.lastAuditResult) {
          statusLines.push(...formatAuditResult(state.lastAuditResult))
        }

        statusLines.push(
          '',
          `Completion promise: ${state.completionSignal ?? 'none'}`,
          `Started: ${state.startedAt}`,
          ...(state.errorCount && state.errorCount > 0 ? [`Error count: ${state.errorCount} (retries before termination: ${MAX_RETRIES})`] : []),
          `Audit count: ${state.auditCount ?? 0}`,
          `Model: ${state.executionModel ?? config.loop?.model ?? config.executionModel ?? 'default'}`,
          `Auditor model: ${state.auditorModel ?? config.auditorModel ?? state.executionModel ?? config.loop?.model ?? config.executionModel ?? 'default'}`,
          ...(stallCount > 0 ? [`Stalls: ${stallCount}`] : []),
          ...(secondsSinceActivity !== null ? [`Last activity: ${secondsSinceActivity}s ago`] : []),
          '',
          `Prompt: ${promptPreview}`,
        )

        return statusLines.join('\n')
      },
    }),
  }
}
