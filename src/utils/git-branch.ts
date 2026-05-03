import type { LoopService } from '../services/loop'
import { execSync } from 'child_process'

/**
 * Injects the current git branch field into a JSON object for review findings.
 * Resolution order:
 * 1. If sessionId is provided, use the loop state for that session
 * 2. Match active loop by worktreeDir or projectDir
 * 3. Fall back to git command
 * 
 * @param value - The object to inject the branch field into
 * @param directory - The directory to check for git branch
 * @param loopService - The loop service for checking active loops
 * @param sessionId - Optional session ID to resolve loop state directly
 */
export function injectBranchField(
  value: unknown,
  directory: string,
  loopService: LoopService,
  sessionId?: string,
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return
  
  let worktreeBranch: string | undefined
  
  // Priority 1: If sessionId is provided, resolve loop state directly
  if (sessionId) {
    const loopName = loopService.resolveLoopName(sessionId)
    if (loopName) {
      const state = loopService.getActiveState(loopName)
      if (state?.worktreeBranch) {
        worktreeBranch = state.worktreeBranch
      }
    }
  }
  
  // Priority 2: Match active loop by directory
  if (!worktreeBranch) {
    const active = loopService.listActive()
    const loop = active.find((s) => s.worktreeDir === directory || s.projectDir === directory)
    if (loop?.worktreeBranch) {
      worktreeBranch = loop.worktreeBranch
    }
  }
  
  // Priority 3: Fall back to git branch
  if (!worktreeBranch) {
    const branch = resolveCurrentGitBranch(directory)
    if (branch) {
      worktreeBranch = branch
    }
  }
  
  if (worktreeBranch) {
    ;(value as Record<string, unknown>).branch = worktreeBranch
  }
}

export function resolveCurrentGitBranch(directory: string): string | undefined {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: directory,
      encoding: 'utf-8',
    }).trim()
    return branch || undefined
  } catch {
    return undefined
  }
}
