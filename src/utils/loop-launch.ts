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

export interface FreshLoopOptions {
  planText: string
  title: string
  directory: string
  projectId: string
  isWorktree: boolean
  api: TuiPluginApi
  dbPath?: string
}

export interface LaunchResult {
  sessionId: string
  loopName: string
  worktreeName: string
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
          if (state?.worktreeName) {
            existingNames.push(state.worktreeName)
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
  
  if (isWorktree) {
    // Create worktree and session
    const worktreeResult = await api.client.worktree.create({
      worktreeCreateInput: { name: uniqueWorktreeName },
    })
    
    if (worktreeResult.error || !worktreeResult.data) {
      return null
    }
    
    sessionDirectory = worktreeResult.data.directory
    worktreeBranch = worktreeResult.data.branch
    
    const createResult = await api.client.session.create({
      title: `Loop: ${title}`,
      directory: sessionDirectory,
      // Note: Cannot set permission ruleset from TUI - handled by loop service
    })
    
    if (createResult.error || !createResult.data) {
      return null
    }
    
    sessionId = createResult.data.id
  } else {
    // In-place loop
    const createResult = await api.client.session.create({
      title: `Loop: ${title}`,
      directory,
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
      const queries = createKvQuery(db)
      const now = Date.now()
      const TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
      
      // Store plan with unique worktree name key
      queries.set(projectId, `plan:${uniqueWorktreeName}`, JSON.stringify(planText), now + TTL_MS)
      
      // Store loop state in KV
      const loopState = {
        active: true,
        sessionId,
        worktreeName: uniqueWorktreeName,
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
      }
      
      queries.set(projectId, `loop:${uniqueWorktreeName}`, JSON.stringify(loopState), now + TTL_MS)
      
      // Store session mapping
      queries.set(projectId, `loop-session:${sessionId}`, JSON.stringify(uniqueWorktreeName), now + TTL_MS)
    } catch {
      // Continue even if DB operations fail
    } finally {
      try { db?.close() } catch {}
    }
  }
  
  // Build prompt with completion signal
  let promptText = planText
  if (DEFAULT_COMPLETION_SIGNAL) {
    promptText += buildCompletionSignalInstructions(DEFAULT_COMPLETION_SIGNAL)
  }
  
  // Send prompt to code agent
  try {
    await api.client.session.promptAsync({
      sessionID: sessionId,
      directory: sessionDirectory,
      parts: [{ type: 'text' as const, text: promptText }],
      agent: 'code',
    })
  } catch {
    return null
  }
  
  return {
    sessionId,
    loopName: displayName,
    worktreeName: uniqueWorktreeName,
    isWorktree,
    worktreeDir: sessionDirectory,
    worktreeBranch,
  }
}
