import type { GitService } from '../utils/git-service'

const WORKTREE_PREFIX = 'worktree '
const BRANCH_PREFIX = 'branch refs/heads/'

/**
 * Finds the worktree that has `branch` checked out by walking `git worktree list --porcelain`
 * blocks, each a `worktree <path>` line followed by its own `branch <ref>` line.
 */
export function findWorktreeForBranch(git: GitService, repoDir: string, branch: string): string | null {
  const listed = git.worktreeList(repoDir)
  if (!listed.ok) return null
  let worktreePath: string | null = null
  for (const line of listed.stdout.split(/\r?\n/)) {
    if (line.startsWith(WORKTREE_PREFIX)) {
      worktreePath = line.slice(WORKTREE_PREFIX.length)
      continue
    }
    if (worktreePath !== null && line === `${BRANCH_PREFIX}${branch}`) return worktreePath
  }
  return null
}

/**
 * A branch is reusable when it is absent, equal to `baseRef`, or an ancestor of it. Anything else
 * carries commits the loop's base ref does not contain.
 */
export function describeBranchReuseConflict(
  git: GitService,
  repoDir: string,
  branch: string,
  baseRef: string,
): string | null {
  if (!git.branchExists(repoDir, branch)) return null
  if (git.isAncestor(repoDir, branch, baseRef)) return null
  return `Branch ${branch} has commits that ${baseRef} does not contain; refusing to reuse it for a loop based on ${baseRef}`
}

export type LoopBranchRequest = { branch?: string; baseRef?: string }

export function validateLoopBranchRequest(
  git: GitService,
  repoDir: string,
  request: LoopBranchRequest,
): { ok: true } | { ok: false; message: string } {
  const branch = request.branch ? request.branch : undefined
  const baseRef = request.baseRef ? request.baseRef : undefined

  if (baseRef && !git.revParse(repoDir, baseRef).ok) {
    return { ok: false, message: `Base ref ${baseRef} does not resolve to a commit in ${repoDir}; fetch it first` }
  }

  if (branch) {
    const checked = git.checkRefFormatBranch(repoDir, branch)
    if (!checked.ok || checked.stdout.trim() !== branch) {
      return { ok: false, message: `Invalid branch name "${branch}"` }
    }

    const worktreePath = findWorktreeForBranch(git, repoDir, branch)
    if (worktreePath !== null) {
      return {
        ok: false,
        message: `Branch ${branch} is checked out in worktree ${worktreePath}; choose another branch or free it`,
      }
    }
  }

  if (branch && baseRef) {
    const conflict = describeBranchReuseConflict(git, repoDir, branch, baseRef)
    if (conflict !== null) return { ok: false, message: conflict }
  }

  return { ok: true }
}
