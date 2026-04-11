import type { LoopService } from '../services/loop'
import { execSync } from 'child_process'

/**
 * Injects the current git branch field into a JSON object for review findings.
 * Checks active memory loops first, then falls back to git command.
 * 
 * @param value - The object to inject the branch field into
 * @param directory - The directory to check for git branch
 * @param loopService - The loop service for checking active loops
 */
export function injectBranchField(
  value: unknown,
  directory: string,
  loopService: LoopService
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return
  
  const active = loopService.listActive()
  const loop = active.find((s) => s.worktreeDir === directory)
  
  if (loop?.worktreeBranch) {
    ;(value as Record<string, unknown>).branch = loop.worktreeBranch
  } else {
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: directory,
        encoding: 'utf-8',
      }).trim()
      if (branch) {
        ;(value as Record<string, unknown>).branch = branch
      }
    } catch {
      // git not available or not a repo
    }
  }
}
