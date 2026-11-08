import { join, relative, isAbsolute, sep, dirname, basename } from 'path'
import { readdirSync } from 'fs'
import { slugify } from '../utils/logger'
import { defaultGitService, type GitService } from '../utils/git-service'
import { canonicalizePath } from '../sandbox/path'
import { SECTION_ID_PATTERN } from '../loop/section-graph'

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

/**
 * Branch a loop's worktree lives on: the explicit branch when one was recorded,
 * otherwise the canonical `forge/<slug>` derivation from the loop name.
 */
export function resolveLoopBranchName(loopName: string, explicitBranch?: string | null): string {
  return typeof explicitBranch === 'string' && explicitBranch.length > 0
    ? explicitBranch
    : forgeBranchName(loopName)
}

export function forgeWorktreesRoot(dataDir: string): string {
  return join(dataDir, 'worktrees')
}

export function forgeWorktreeDir(dataDir: string, loopName: string): string {
  return join(forgeWorktreesRoot(dataDir), forgeWorktreeSlug(loopName))
}

const LANES_DIR_SUFFIX = '.lanes'

/**
 * Root directory holding a loop worktree's parallel section lanes: sibling
 * directories named `<worktreeDir>.lanes` so they never nest inside the loop
 * worktree they belong to.
 */
export function forgeLanesDir(worktreeDir: string): string {
  return `${worktreeDir}${LANES_DIR_SUFFIX}`
}

/**
 * Directory a single section lane is checked out into, under its loop worktree's
 * lanes root and named after the section id.
 */
export function forgeLaneDir(worktreeDir: string, sectionId: string): string {
  return join(forgeLanesDir(worktreeDir), sectionId)
}

/**
 * Branch a section lane runs on, scoped to the loop's worktree slug so lanes of
 * different loops cannot collide.
 */
export function forgeLaneBranchName(loopName: string, sectionId: string): string {
  return `forge-lane/${forgeWorktreeSlug(loopName)}/${sectionId}`
}

/**
 * Splits a lane directory back into the loop worktree it belongs to and the
 * section id it runs. Returns null unless `directory` is
 * `<worktreeDir>.lanes/<sectionId>` with a slug-shaped worktree name and a valid
 * section id.
 */
export function parseForgeLaneDir(directory: string): { loopWorktreeDir: string; sectionId: string } | null {
  if (!directory) return null
  const canonical = canonicalizePath(directory)
  const lanesDir = dirname(canonical)
  const lanesName = basename(lanesDir)
  if (!lanesName.endsWith(LANES_DIR_SUFFIX)) return null
  const slug = lanesName.slice(0, -LANES_DIR_SUFFIX.length)
  if (!slug || slug !== forgeWorktreeSlug(slug)) return null
  const sectionId = basename(canonical)
  if (!SECTION_ID_PATTERN.test(sectionId)) return null
  return { loopWorktreeDir: join(dirname(lanesDir), slug), sectionId }
}

/**
 * Absolute paths of every loop worktree directory directly under
 * `<dataDir>/worktrees`, or an empty list when that root does not exist. Lane
 * roots (`<worktreeDir>.lanes`) are skipped because they are siblings of the
 * worktrees, not worktrees themselves. Other filesystem errors propagate to the
 * caller.
 */
export function listForgeWorktreeDirs(dataDir: string): string[] {
  const root = forgeWorktreesRoot(dataDir)
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.endsWith(LANES_DIR_SUFFIX))
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
 * directory. Startup-only recovery must not run for these child instances, since
 * the owning process is still alive and may be actively driving state in the same
 * project.
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
  const branch = resolveLoopBranchName(state.loopName, state.worktreeBranch)
  return gitBranchExists(repoDir, branch, git)
}
