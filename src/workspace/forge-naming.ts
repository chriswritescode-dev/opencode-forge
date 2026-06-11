import { join } from 'path'
import { spawnSync } from 'child_process'
import { slugify } from '../utils/logger'

/**
 * Canonical naming for forge worktrees and their scratch branches.
 *
 * These helpers are the single source of truth shared by the workspace adapter
 * (which creates the worktree) and the restart path (which decides whether a
 * loop can resume from a surviving branch). Keeping the derivation in one place
 * ensures the branch the adapter reuses on `create` is the same branch the
 * restart guard probes for.
 */
export function forgeWorktreeSlug(loopName: string): string {
  return slugify(loopName)
}

export function forgeBranchName(loopName: string): string {
  return `forge/${forgeWorktreeSlug(loopName)}`
}

export function forgeWorktreeDir(dataDir: string, loopName: string): string {
  return join(dataDir, 'worktrees', forgeWorktreeSlug(loopName))
}

/**
 * True when a local git branch exists in the given repository working directory.
 * Used to decide whether a loop whose worktree directory was pruned can still be
 * restarted by recreating the worktree from the surviving branch.
 */
export function gitBranchExists(repoDir: string, branch: string): boolean {
  if (!repoDir || !branch) return false
  const res = spawnSync(
    'git',
    ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
    { cwd: repoDir, encoding: 'utf-8' },
  )
  return res.status === 0
}

/**
 * Reports whether a loop's scratch branch still exists, so a loop whose worktree
 * directory was pruned can still be restarted by recreating the worktree from the
 * branch. Prefers the persisted branch name and falls back to the canonical
 * `forge/<loopName>` derivation used by the workspace adapter.
 */
export function loopBranchExists(
  state: { loopName: string; worktreeBranch?: string; projectDir?: string },
  fallbackDir: string,
): boolean {
  const repoDir = state.projectDir || fallbackDir
  const branch = state.worktreeBranch && state.worktreeBranch.length > 0
    ? state.worktreeBranch
    : forgeBranchName(state.loopName)
  return gitBranchExists(repoDir, branch)
}
