/**
 * Fresh loop launch helper for TUI and tool-side execution.
 * 
 * This module provides functions to create fresh loop sessions
 * separate from the restartLoop() function which requires preexisting loop state.
 */

import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { join } from 'path'
import { generateUniqueName } from '../services/loop'
import { extractLoopNames } from './plan-execution'
import { resolveDataDir } from '../storage'
import { buildLoopPermissionRuleset } from '../constants/loop'
import { resolveWorktreeLogTarget } from '../services/worktree-log'
import { waitForGraphReady } from './tui-graph-status'
import { retryWithModelFallback, parseModelString } from './model-fallback'
import { loadPluginConfig } from '../setup'
import { createLoopsRepo } from '../storage/repos/loops-repo'
import type { LoopRow, LoopLargeFields } from '../storage/repos/loops-repo'
import { createLoopWorkspace } from '../workspace/forge-worktree'
import { createLoopSessionWithWorkspace } from './loop-session'

interface FreshLoopOptions {
  planText: string
  title: string
  directory: string
  projectId: string
  isWorktree: boolean
  api: TuiPluginApi
  dbPath?: string
  executionModel?: string
  auditorModel?: string
  /** Optional override for sandbox enabled state (for testing) */
  sandboxEnabled?: boolean
  /** Skip sandbox wait (for testing - sandbox reconciliation won't occur) */
  skipSandboxWait?: boolean
  hostSessionId?: string
}

interface LaunchResult {
  sessionId: string
  loopName: string
  executionName: string
  isWorktree: boolean
  worktreeDir?: string
  worktreeBranch?: string
  workspaceId?: string
  hostSessionId?: string
}

/**
 * Launches a fresh loop session (either in-place or in a worktree).
 * This is separate from restartLoop() which requires preexisting loop state.
 * 
 * @returns LaunchResult with session ID, loop name, and worktree details if successful, null otherwise
 */
export async function launchFreshLoop(options: FreshLoopOptions): Promise<LaunchResult | null> {
  const { planText, title, directory, projectId, isWorktree, api } = options

  // Extract loop name from plan (uses explicit Loop Name field or falls back to title)
  const { displayName, executionName } = extractLoopNames(planText)

  // Read existing loop names from loops table to generate a unique worktree name
  const dbPath = options.dbPath ?? join(resolveDataDir(), 'graph.db')
  const existingNames: string[] = []
  
  if (existsSync(dbPath)) {
    let db: Database | null = null
    try {
      db = new Database(dbPath, { readonly: true })
      const stmt = db.prepare('SELECT loop_name FROM loops WHERE project_id = ?')
      const rows = stmt.all(projectId) as Array<{ loop_name: string }>
      
      for (const row of rows) {
        existingNames.push(row.loop_name)
      }
    } catch {
      // Continue even if we can't read existing names
    } finally {
      try { db?.close() } catch {}
    }
  }
  
  // Generate unique worktree name before any side effects
  const uniqueWorktreeName = generateUniqueName(executionName, existingNames)
  
  // Create session based on worktree mode
  let sessionId: string
  let worktreeBranch: string | undefined
  let workspaceId: string | undefined
  let hostWorktreeDir: string | undefined
  
  // Load config early to determine sandbox state for loop state persistence
  const config = loadPluginConfig()
  const dataDir = resolveDataDir()
  const isSandboxEnabled = options.sandboxEnabled ?? (config.sandbox?.mode === 'docker')
  
  if (isWorktree) {
    // Create worktree first to get the actual directory
    const worktreeResult = await api.client.worktree.create({
      worktreeCreateInput: { name: uniqueWorktreeName },
    })
    
    if (worktreeResult.error || !worktreeResult.data) {
      return null
    }
    
    hostWorktreeDir = worktreeResult.data.directory
    worktreeBranch = worktreeResult.data.branch
    
    // Seed graph cache from source repo to worktree scope before session creation
    const seedResult = await (async () => {
      try {
        const { seedWorktreeGraphScope } = await import('./worktree-graph-seed')
        return await seedWorktreeGraphScope({
          projectId: options.projectId,
          sourceCwd: directory,
          targetCwd: hostWorktreeDir,
          dataDir: resolveDataDir(),
        })
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        return { seeded: false, reason }
      }
    })()
    console.log(`loop-launch: graph seed ${seedResult.seeded ? 'reused' : 'skipped'} (${seedResult.reason})`)
    
    // Optionally create a workspace and bind the session so the worktree loop
    // can be switched to directly from the TUI. If the host runtime doesn't
    // expose experimental_workspace, the loop continues without workspace
    // backing — the user just can't switch via the workspace UI.
    const workspace = await createLoopWorkspace(api.client, {
      loopName: uniqueWorktreeName,
      directory: hostWorktreeDir,
      branch: worktreeBranch,
    })

    if (!workspace) {
      console.log(`loop-launch: workspace API unavailable or create failed; continuing without workspace backing for ${uniqueWorktreeName}`)
    }

    // Worktree sessions no longer need log directory access since logging is dispatched via host session
    const permissionRuleset = buildLoopPermissionRuleset(config, null, {
      isWorktree: true,
    })
    
    console.log(`loop-launch: creating session with directory=${hostWorktreeDir} (sandbox: ${isSandboxEnabled})`)

    const createResult = await createLoopSessionWithWorkspace({
      v2: api.client,
      title: `Loop: ${title}`,
      directory: hostWorktreeDir,
      permission: permissionRuleset,
      workspaceId: workspace?.workspaceId,
      logPrefix: 'loop-launch',
      logger: console,
    })
    
    if (!createResult) {
      return null
    }
    
    sessionId = createResult.sessionId
    workspaceId = createResult.boundWorkspaceId

    if (createResult.bindFailed) {
      console.error('loop-launch: continuing without workspace backing')
    }
  } else {
    // In-place loop - may still need log directory access if direct logging is used
    const logTarget = resolveWorktreeLogTarget(config, {
      projectDir: directory,
      sandboxHostDir: undefined,
      sandbox: isSandboxEnabled,
      dataDir,
    })
    const permissionRuleset = buildLoopPermissionRuleset(config, logTarget?.permissionPath ?? null, {
      isWorktree: false,
    })
    
    const createResult = await api.client.session.create({
      title: `Loop: ${title}`,
      directory,
      permission: permissionRuleset,
    })
    
    if (createResult.error || !createResult.data) {
      return null
    }
    
    sessionId = createResult.data.id
  }
  
  // Store plan and loop state in KV if database exists
  const dbExists = existsSync(dbPath)
  
  // Hoist loopState into outer scope for use in sandbox wait and abort logic
  const loopState = {
    active: true,
    sessionId,
    loopName: uniqueWorktreeName,
    projectDir: directory,
    worktreeDir: hostWorktreeDir ?? directory,
    worktreeBranch,
    iteration: 1,
    maxIterations: 0,
    startedAt: new Date().toISOString(),
    prompt: planText,
    phase: 'coding' as const,
    audit: true,
    errorCount: 0,
    auditCount: 0,
    worktree: isWorktree,
    sandbox: isSandboxEnabled,
    executionModel: options.executionModel,
    auditorModel: options.auditorModel,
    workspaceId,
  }
  
  if (dbExists) {
    let db: Database | null = null
    try {
      db = new Database(dbPath)
      db.run('PRAGMA busy_timeout=5000')
      const now = Date.now()
      
      console.log(`[forge] loop-launch: storing loop state executionModel=${loopState.executionModel || '(default)'} auditorModel=${loopState.auditorModel || '(default)'}`)
      
      const row: LoopRow = {
        projectId,
        loopName: uniqueWorktreeName,
        status: 'running',
        currentSessionId: sessionId,
        worktree: isWorktree,
        worktreeDir: hostWorktreeDir ?? directory,
        worktreeBranch: worktreeBranch ?? null,
        projectDir: directory,
        maxIterations: loopState.maxIterations,
        iteration: loopState.iteration,
        auditCount: loopState.auditCount,
        errorCount: loopState.errorCount,
        phase: loopState.phase,
        audit: loopState.audit,
        executionModel: loopState.executionModel ?? null,
        auditorModel: loopState.auditorModel ?? null,
        modelFailed: false,
        sandbox: isSandboxEnabled,
        sandboxContainer: null,
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: workspaceId ?? null,
        hostSessionId: options.hostSessionId ?? null,
      }
      
      const large: LoopLargeFields = {
        prompt: planText,
        lastAuditResult: null,
      }
      
      const inserted = createLoopsRepo(db).insert(row, large)
      if (!inserted) {
        throw new Error(`Failed to insert loop state for ${uniqueWorktreeName}`)
      }
    } catch (err) {
      console.error('[forge] loop-launch: failed to persist loop state', err)
      // Clean up the session if we created one
      if (sessionId) {
        try {
          await api.client.session.abort({ sessionID: sessionId })
        } catch (abortErr) {
          console.error('[forge] loop-launch: failed to abort session after error', abortErr)
        }
      }
      return null
    } finally {
      try { db?.close() } catch {}
    }
  }
  
  // Build prompt
  const promptText = planText
  
  // Wait for worktree graph to be ready before first prompt (only for worktree mode)
  if (isWorktree && hostWorktreeDir) {
    try {
      await waitForGraphReady(projectId, {
        dbPathOverride: dbPath,
        cwd: hostWorktreeDir,
        pollMs: 100,
        timeoutMs: 5000,
      })
    } catch {
      // Non-fatal: continue even if wait fails
    }
  }

  // Wait for sandbox to be ready before first prompt (only for worktree + sandbox mode)
  // Skip if db doesn't exist (no reconciliation can occur) or if skipSandboxWait is set (for testing)
  if (isWorktree && isSandboxEnabled && dbExists && !options.skipSandboxWait) {
    const { waitForSandboxReady } = await import('./sandbox-ready')
    const waitResult = await waitForSandboxReady({
      projectId,
      loopName: uniqueWorktreeName,
      dbPath,
      pollMs: 200,
      timeoutMs: 15_000,
    })
    if (!waitResult.ready) {
      console.error(`[forge] loop-launch: sandbox not ready (${waitResult.reason}); aborting launch`)

      // Best-effort: stop any container reconciliation may have started in the meantime.
      // We don't have a SandboxManager reference here, so talk to DockerService directly.
      try {
        const { createDockerService } = await import('../sandbox/docker')
        const docker = createDockerService(console)
        const containerName = docker.containerName(uniqueWorktreeName)
        if (await docker.isRunning(containerName)) {
          await docker.removeContainer(containerName)
          console.log(`[forge] loop-launch: removed sandbox container ${containerName} after aborted launch`)
        }
      } catch (err) {
        console.error('[forge] loop-launch: failed to remove sandbox container after abort', err)
      }

      // Mark the loop inactive so it doesn't dangle
      let db: Database | null = null
      try {
        db = new Database(dbPath)
        db.run('PRAGMA busy_timeout=5000')
        const now = Date.now()
        db.prepare(`
          UPDATE loops SET
            status = ?,
            completed_at = ?,
            termination_reason = ?,
            completion_summary = ?
          WHERE project_id = ? AND loop_name = ?
        `).run('errored', now, 'sandbox_start_failed: ' + waitResult.reason, null, projectId, uniqueWorktreeName)
      } catch (err) {
        console.error('[forge] loop-launch: failed to mark loop inactive after sandbox timeout', err)
      } finally {
        try {
          db?.close()
        } catch (err) {
          console.error('[forge] loop-launch: failed to close db', err)
        }
      }
      return null
    }
    console.log(`[forge] loop-launch: sandbox ready container=${waitResult.containerName}`)
  }

  // Send prompt to code agent with model fallback
  const loopModel = parseModelString(options.executionModel) ?? parseModelString(config.loop?.model) ?? parseModelString(config.executionModel)
  const sessionDir = loopState.worktreeDir
  
  console.log(`loop-launch: initial prompt sessionID=${sessionId} dir=${sessionDir} model=${loopModel ? `${loopModel.providerID}/${loopModel.modelID}` : '(default)'}`)
  
  const promptParts = [{ type: 'text' as const, text: promptText }]
  const { result: promptResult } = await retryWithModelFallback(
    () => loopModel
      ? api.client.session.promptAsync({ sessionID: sessionId, directory: sessionDir, agent: 'code', model: loopModel, parts: promptParts })
      : api.client.session.promptAsync({ sessionID: sessionId, directory: sessionDir, agent: 'code', parts: promptParts }),
    () => api.client.session.promptAsync({ sessionID: sessionId, directory: sessionDir, agent: 'code', parts: promptParts }),
    loopModel,
    console,
  )
  
  if (promptResult.error) {
    return null
  }
  
  return {
    sessionId,
    loopName: displayName,
    executionName: uniqueWorktreeName,
    isWorktree,
    worktreeDir: hostWorktreeDir ?? directory,
    worktreeBranch,
    workspaceId,
    hostSessionId: options.hostSessionId,
  }
}
