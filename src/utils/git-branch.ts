import type { LoopService } from '../services/loop'
import { execSync } from 'child_process'

export type FindingScope =
  | { kind: 'loop'; loopName: string }
  | { kind: 'branch'; branch: string }
  | { kind: 'none' }

/**
 * Resolves the finding scope for the current context.
 * Resolution order:
 * 1. If sessionId is provided, resolve loop name from loop service
 * 2. Match active loop by worktreeDir or projectDir
 * 3. Fall back to git branch
 * 4. Return none if no scope found
 * 
 * @param directory - The directory to check for git branch
 * @param loopService - The loop service for checking active loops
 * @param sessionId - Optional session ID to resolve loop state directly
 * @returns The resolved finding scope
 */
export function resolveFindingScope(
  directory: string,
  loopService: LoopService,
  sessionId?: string,
): FindingScope {
  // Priority 1: If sessionId is provided, resolve loop name directly
  if (sessionId) {
    const loopName = loopService.resolveLoopName(sessionId)
    if (loopName) {
      return { kind: 'loop', loopName }
    }
  }
  
  // Priority 2: Match active loop by directory
  const active = loopService.listActive()
  const loop = active.find((s) => s.worktreeDir === directory || s.projectDir === directory)
  if (loop?.loopName) {
    return { kind: 'loop', loopName: loop.loopName }
  }
  
  // Priority 3: Fall back to git branch
  const branch = resolveCurrentGitBranch(directory)
  if (branch) {
    return { kind: 'branch', branch }
  }
  
  // Priority 4: No scope found
  return { kind: 'none' }
}

/**
 * Injects the appropriate scope field (loopName or branch) into a JSON object for review findings.
 * Resolution order:
 * 1. If sessionId is provided, use the loop state for that session
 * 2. Match active loop by worktreeDir or projectDir
 * 3. Fall back to git command
 * 
 * Only ONE of loopName or branch will be set - never both.
 * 
 * @param value - The object to inject the scope field into
 * @param directory - The directory to check for git branch
 * @param loopService - The loop service for checking active loops
 * @param sessionId - Optional session ID to resolve loop state directly
 */
export function injectScopeField(
  value: unknown,
  directory: string,
  loopService: LoopService,
  sessionId?: string,
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return
  
  const scope = resolveFindingScope(directory, loopService, sessionId)
  const record = value as Record<string, unknown>
  
  if (scope.kind === 'loop') {
    record.loopName = scope.loopName
    record.branch = null
  } else if (scope.kind === 'branch') {
    record.branch = scope.branch
    record.loopName = null
  } else {
    // kind === 'none' - set both to null
    record.branch = null
    record.loopName = null
  }
}

/**
 * @deprecated Use injectScopeField instead. This alias is provided for backward compatibility.
 */
export function injectBranchField(
  value: unknown,
  directory: string,
  loopService: LoopService,
  sessionId?: string,
): void {
  return injectScopeField(value, directory, loopService, sessionId)
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
