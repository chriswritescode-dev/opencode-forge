import { execSync, spawnSync } from 'child_process'
import { resolve } from 'path'
import { existsSync } from 'fs'
import type { Logger } from '../types'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'

interface WorktreeCleanupInput {
  worktreeDir: string
  logPrefix: string
  logger: Logger | Console
}

interface WorktreeCleanupResult {
  removed: boolean
  error?: string
}

export async function cleanupLoopWorktree(
  input: WorktreeCleanupInput,
): Promise<WorktreeCleanupResult> {
  const result: WorktreeCleanupResult = {
    removed: false,
  }

  try {
    if (!existsSync(input.worktreeDir)) {
      result.removed = true
      input.logger.log(`${input.logPrefix}: worktree directory already removed ${input.worktreeDir}`)
      try {
        const gitCommonDir = execSync('git rev-parse --git-common-dir', { cwd: input.worktreeDir, encoding: 'utf-8' }).trim()
        const gitRoot = resolve(input.worktreeDir, gitCommonDir, '..')
        spawnSync('git', ['worktree', 'prune'], { cwd: gitRoot, encoding: 'utf-8' })
      } catch {
        // best-effort prune from parent dir if possible
      }
      return result
    }

    const gitCommonDir = execSync('git rev-parse --git-common-dir', { cwd: input.worktreeDir, encoding: 'utf-8' }).trim()
    const gitRoot = resolve(input.worktreeDir, gitCommonDir, '..')
    const removeResult = spawnSync('git', ['worktree', 'remove', '-f', input.worktreeDir], { cwd: gitRoot, encoding: 'utf-8' })
    if (removeResult.status !== 0) {
      const stderr = removeResult.stderr || ''
      if (/Permission denied/.test(stderr) && !existsSync(input.worktreeDir)) {
        result.removed = true
        input.logger.log(`${input.logPrefix}: worktree directory already removed (permission denied during remove)`)
        spawnSync('git', ['worktree', 'prune'], { cwd: gitRoot, encoding: 'utf-8' })
        return result
      }
      throw new Error(removeResult.stderr || 'git worktree remove failed')
    }

    result.removed = true
    input.logger.log(`${input.logPrefix}: removed worktree ${input.worktreeDir}`)

    spawnSync('git', ['worktree', 'prune'], { cwd: gitRoot, encoding: 'utf-8' })

  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    input.logger.error(`${input.logPrefix}: failed to cleanup worktree`, err)
  }

  return result
}

export interface TeardownInput {
  v2: OpencodeClient
  loopName: string
  sessionId: string
  workspaceId?: string | null
  worktreeDir: string
  projectDir?: string | null
  worktree: boolean
  doCommit: boolean
  doRemoveWorktree: boolean
  reasonLabel: string
  worktreeBranch?: string | null
  iteration?: number
  logPrefix: string
  logger: Logger | Console
}

export interface TeardownResult {
  sessionDeleted: boolean
  workspaceDeleted: boolean
  worktreeRemoved: boolean
  committed: boolean
  errors: string[]
}

export async function teardownWorktreeArtifacts(input: TeardownInput): Promise<TeardownResult> {
  const result: TeardownResult = {
    sessionDeleted: false,
    workspaceDeleted: false,
    worktreeRemoved: false,
    committed: false,
    errors: [],
  }

  const log = (msg: string) => input.logger.log(msg)
  const logError = (msg: string, err?: unknown) => {
    input.logger.error(msg, err)
    if (err instanceof Error) {
      result.errors.push(err.message)
    } else if (typeof err === 'string') {
      result.errors.push(err)
    } else if (err && typeof err === 'object' && 'message' in err) {
      result.errors.push(String((err as { message: unknown }).message))
    }
  }

  // Step 1: Commit changes first (if requested)
  if (input.doCommit && input.worktree) {
    try {
      const addResult = spawnSync('git', ['add', '-A'], { cwd: input.worktreeDir, encoding: 'utf-8' })
      if (addResult.status !== 0) {
        throw new Error(addResult.stderr || 'git add failed')
      }

      const statusResult = spawnSync('git', ['status', '--porcelain'], { cwd: input.worktreeDir, encoding: 'utf-8' })
      if (statusResult.status !== 0) {
        throw new Error(statusResult.stderr || 'git status failed')
      }
      const status = statusResult.stdout.trim()

      if (status) {
        const message = `loop: ${input.loopName} ${input.reasonLabel} after ${input.iteration ?? 0} iteration${(input.iteration ?? 0) === 1 ? '' : 's'}`
        const commitResult = spawnSync('git', ['commit', '-m', message], { cwd: input.worktreeDir, encoding: 'utf-8' })
        if (commitResult.status !== 0) {
          throw new Error(commitResult.stderr || 'git commit failed')
        }
        result.committed = true
        log(`${input.logPrefix}: committed changes on branch ${input.worktreeBranch}`)
      } else {
        log(`${input.logPrefix}: no uncommitted changes to commit on branch ${input.worktreeBranch}`)
      }
    } catch (err) {
      logError(`${input.logPrefix}: failed to commit changes in worktree ${input.worktreeDir}`, err)
    }
  }

  // Step 2: Delete session. Loop sessions are created against worktreeDir
  // (see hooks/loop.ts rotateSession + executePromptOnce), so delete must
  // target worktreeDir first. projectDir is the host project root and would
  // silently 404 the delete, leaving a ghost in the session list.
  const candidates: string[] = []
  candidates.push(input.worktreeDir)
  if (input.projectDir && input.projectDir !== input.worktreeDir) {
    candidates.push(input.projectDir)
  }

  for (const sessionDir of candidates) {
    try {
      const deleteResult = await input.v2.session.delete({
        sessionID: input.sessionId,
        directory: sessionDir,
      })
      if (!deleteResult.error) {
        result.sessionDeleted = true
        log(`${input.logPrefix}: deleted session ${input.sessionId} for ${input.loopName} (directory=${sessionDir})`)
        break
      }
      logError(`${input.logPrefix}: session.delete ${input.sessionId} returned error in ${sessionDir}, trying fallback`, deleteResult.error)
    } catch (err) {
      logError(`${input.logPrefix}: session.delete threw for ${input.sessionId} in ${sessionDir}`, err)
    }
  }
  if (!result.sessionDeleted) {
    logError(`${input.logPrefix}: failed to delete loop session ${input.sessionId} across ${candidates.join(', ')}`)
  }

  // Step 3: Delete workspace (if applicable)
  if (input.worktree && input.workspaceId) {
    const workspaceApi = input.v2.experimental?.workspace
    if (workspaceApi?.remove) {
      try {
        const removeResult = await workspaceApi.remove({ id: input.workspaceId })
        if (!removeResult.error) {
          result.workspaceDeleted = true
          log(`${input.logPrefix}: deleted workspace ${input.workspaceId} for ${input.loopName}`)
        } else {
          logError(`${input.logPrefix}: failed to delete workspace ${input.workspaceId}`, removeResult.error)
        }
      } catch (err) {
        logError(`${input.logPrefix}: failed to delete workspace ${input.workspaceId}`, err)
      }
    } else {
      logError(`${input.logPrefix}: experimental.workspace.remove not available`)
    }
  }

  // Step 4: Remove worktree (if requested)
  if (input.doRemoveWorktree && input.worktree) {
    const cleanupResult = await cleanupLoopWorktree({
      worktreeDir: input.worktreeDir,
      logPrefix: input.logPrefix,
      logger: input.logger,
    })
    result.worktreeRemoved = cleanupResult.removed
    if (cleanupResult.error) {
      result.errors.push(cleanupResult.error)
    }
  }

  return result
}
