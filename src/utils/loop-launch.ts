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
import { DEFAULT_COMPLETION_SIGNAL, generateUniqueName, buildCompletionSignalInstructions } from '../services/loop'
import { extractLoopNames } from './plan-execution'
import { createKvQuery } from '../storage/kv-queries'
import { resolveDataDir } from '../storage'
import { buildLoopPermissionRuleset } from '../constants/loop'
import { resolveWorktreeLogTarget } from '../services/worktree-log'
import { agents } from '../agents'
import { waitForGraphReady } from './tui-graph-status'
import { retryWithModelFallback, parseModelString } from './model-fallback'
import { loadPluginConfig } from '../setup'

export interface FreshLoopOptions {
  planText: string
  title: string
  directory: string
  projectId: string
  isWorktree: boolean
  api: TuiPluginApi
  dbPath?: string
  executionModel?: string
  auditorModel?: string
}

export interface LaunchResult {
  sessionId: string
  loopName: string
  executionName: string
  isWorktree: boolean
  worktreeDir?: string
  worktreeBranch?: string
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

  // Read existing loop names from KV to generate a unique worktree name
  const dbPath = options.dbPath ?? join(resolveDataDir(), 'graph.db')
  const existingNames: string[] = []
  
  if (existsSync(dbPath)) {
    let db: Database | null = null
    try {
      db = new Database(dbPath, { readonly: true })
      const stmt = db.prepare('SELECT data FROM project_kv WHERE project_id = ? AND key LIKE ? AND expires_at > ?')
      const rows = stmt.all(projectId, 'loop:%', Date.now()) as Array<{ data: string }>
      
      for (const row of rows) {
        try {
          const state = JSON.parse(row.data)
          if (state?.loopName) {
            existingNames.push(state.loopName)
          }
        } catch {
          // Skip invalid JSON
        }
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
  let sessionDirectory: string
  let worktreeBranch: string | undefined
  
  // Load config early to determine sandbox state for loop state persistence
  const config = loadPluginConfig()
  const dataDir = resolveDataDir()
  const isSandboxEnabled = config.sandbox?.mode === 'docker'
  
  if (isWorktree) {
    // Create worktree first to get the actual directory
    const worktreeResult = await api.client.worktree.create({
      worktreeCreateInput: { name: uniqueWorktreeName },
    })
    
    if (worktreeResult.error || !worktreeResult.data) {
      return null
    }
    
    sessionDirectory = worktreeResult.data.directory
    worktreeBranch = worktreeResult.data.branch
    
    // Seed graph cache from source repo to worktree scope before session creation
    const dbPathForSeed = options.dbPath ?? join(resolveDataDir(), 'graph.db')
    const seedResult = await (async () => {
      try {
        const { seedWorktreeGraphScope } = await import('./worktree-graph-seed')
        return await seedWorktreeGraphScope({
          projectId: options.projectId,
          sourceCwd: directory,
          targetCwd: sessionDirectory,
          dataDir: resolveDataDir(),
          dbPath: dbPathForSeed,
        })
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        return { seeded: false, reason }
      }
    })()
    console.log(`loop-launch: graph seed ${seedResult.seeded ? 'reused' : 'skipped'} (${seedResult.reason})`)
    
    // Worktree sessions no longer need log directory access since logging is dispatched via host session
    const agentExclusions = agents.code.tools?.exclude
    const permissionRuleset = buildLoopPermissionRuleset(config, null, {
      isWorktree: true,
      agentExclusions,
    })
    
    const createResult = await api.client.session.create({
      title: `Loop: ${title}`,
      directory: sessionDirectory,
      permission: permissionRuleset,
    })
    
    if (createResult.error || !createResult.data) {
      return null
    }
    
    sessionId = createResult.data.id
  } else {
    // In-place loop - may still need log directory access if direct logging is used
    const logTarget = resolveWorktreeLogTarget(config, {
      projectDir: directory,
      sandboxHostDir: undefined,
      sandbox: isSandboxEnabled,
      dataDir,
    })
    const agentExclusions = agents.code.tools?.exclude
    const permissionRuleset = buildLoopPermissionRuleset(config, logTarget?.permissionPath ?? null, {
      isWorktree: false,
      agentExclusions,
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
    sessionDirectory = directory
  }
  
  // Store plan and loop state in KV if database exists
  const dbExists = existsSync(dbPath)
  
  if (dbExists) {
    let db: Database | null = null
    try {
      db = new Database(dbPath)
      db.run('PRAGMA busy_timeout=5000')
      const queries = createKvQuery(db)
      const now = Date.now()
      const TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
      
      // Store plan with unique worktree name key
      queries.set(projectId, `plan:${uniqueWorktreeName}`, JSON.stringify(planText), now + TTL_MS)
      
      // Store loop state in KV
      const loopState = {
        active: true,
        sessionId,
        loopName: uniqueWorktreeName,
        projectDir: directory,
        worktreeDir: sessionDirectory,
        worktreeBranch,
        iteration: 1,
        maxIterations: 0,
        completionSignal: DEFAULT_COMPLETION_SIGNAL,
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
      }
      
      console.log(`[forge] loop-launch: storing loop state executionModel=${loopState.executionModel || '(default)'} auditorModel=${loopState.auditorModel || '(default)'}`)
      queries.set(projectId, `loop:${uniqueWorktreeName}`, JSON.stringify(loopState), now + TTL_MS)
      
      // Store session mapping
      queries.set(projectId, `loop-session:${sessionId}`, JSON.stringify(uniqueWorktreeName), now + TTL_MS)
    } catch (err) {
      console.error('[forge] loop-launch: failed to persist loop state to KV', err)
    } finally {
      try { db?.close() } catch {}
    }
  }
  
  // Build prompt with completion signal
  let promptText = planText
  if (DEFAULT_COMPLETION_SIGNAL) {
    promptText += buildCompletionSignalInstructions(DEFAULT_COMPLETION_SIGNAL)
  }
  
  // Wait for worktree graph to be ready before first prompt (only for worktree mode)
  if (isWorktree) {
    try {
      await waitForGraphReady(projectId, {
        dbPathOverride: dbPath,
        cwd: sessionDirectory,
        pollMs: 100,
        timeoutMs: 5000,
      })
    } catch {
      // Non-fatal: continue even if wait fails
    }
  }
  
  // Send prompt to code agent with model fallback
  const loopModel = parseModelString(options.executionModel) ?? parseModelString(config.loop?.model) ?? parseModelString(config.executionModel)
  
  const promptParts = [{ type: 'text' as const, text: promptText }]
  const { result: promptResult } = await retryWithModelFallback(
    () => loopModel
      ? api.client.session.promptAsync({ sessionID: sessionId, directory: sessionDirectory, agent: 'code', model: loopModel, parts: promptParts })
      : api.client.session.promptAsync({ sessionID: sessionId, directory: sessionDirectory, agent: 'code', parts: promptParts }),
    () => api.client.session.promptAsync({ sessionID: sessionId, directory: sessionDirectory, agent: 'code', parts: promptParts }),
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
    worktreeDir: sessionDirectory,
    worktreeBranch,
  }
}
