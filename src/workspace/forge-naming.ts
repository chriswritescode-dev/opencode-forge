import { join, relative, isAbsolute, sep } from 'path'
import { readdirSync } from 'fs'
import { slugify } from '../utils/logger'
import { defaultGitService, type GitService } from '../utils/git-service'

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

export function forgeWorktreesRoot(dataDir: string): string {
  return join(dataDir, 'worktrees')
}

export function forgeWorktreeDir(dataDir: string, loopName: string): string {
  return join(forgeWorktreesRoot(dataDir), forgeWorktreeSlug(loopName))
}

/**
 * Absolute paths of every directory directly under `<dataDir>/worktrees`, or an
 * empty list when that root does not exist. Other filesystem errors propagate to
 * the caller.
 */
export function listForgeWorktreeDirs(dataDir: string): string[] {
  const root = forgeWorktreesRoot(dataDir)
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/**
 * True when `directory` is `root` itself or any directory beneath it.
 */
export function isWithinDir(root: string, directory: string): boolean {
  if (!root || !directory) return false
  const rel = relative(root, directory)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * True when `directory` is the forge worktrees root (`<dataDir>/worktrees`) or
 * any directory beneath it.
 *
 * A forge worktree is always a child context of a live plugin instance — when a
 * loop creates its worktree, OpenCode instantiates a fresh plugin for that
 * directory. Startup-only recovery (e.g. marking orphaned feature groups
 * interrupted) must not run for these child instances, since the owning process
 * is still alive and may be actively driving those groups in the same project.
 */
export function isForgeWorktreeDir(dataDir: string, directory: string): boolean {
  return isWithinDir(forgeWorktreesRoot(dataDir), directory)
}

/**
 * True when a local git branch exists in the given repository working directory.
 * Used to decide whether a loop whose worktree directory was pruned can still be
 * restarted by recreating the worktree from the surviving branch.
 */
export function gitBranchExists(repoDir: string, branch: string, git: GitService = defaultGitService): boolean {
  if (!repoDir || !branch) return false
  return git.branchExists(repoDir, branch)
}

/**
 * Reports whether a loop's scratch branch still exists, so a loop whose worktree
 * directory was pruned can still be restarted by recreating the worktree from the
 * branch. Prefers the persisted branch name and falls back to the canonical
 * `forge/<loopName>` derivation used by the workspace adapter.
 */
export function loopBranchExists(
  state: { loopName: string; worktreeBranch?: string | null; projectDir?: string | null },
  fallbackDir: string,
  git: GitService = defaultGitService,
): boolean {
  const repoDir = state.projectDir || fallbackDir
  const branch = state.worktreeBranch && state.worktreeBranch.length > 0
    ? state.worktreeBranch
    : forgeBranchName(state.loopName)
  return gitBranchExists(repoDir, branch, git)
}
