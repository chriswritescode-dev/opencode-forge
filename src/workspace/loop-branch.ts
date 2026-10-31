import type { GitService } from '../utils/git-service'

const WORKTREE_PREFIX = 'worktree '
const BRANCH_PREFIX = 'branch refs/heads/'
const PRUNABLE_PREFIX = 'prunable'

function splitPorcelainBlocks(stdout: string): string[][] {
  const blocks: string[][] = []
  let current: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === '') {
      if (current.length > 0) blocks.push(current)
      current = []
      continue
    }
    current.push(line)
  }
  if (current.length > 0) blocks.push(current)
  return blocks
}

/**
 * Finds the worktree that has `branch` checked out by walking `git worktree list --porcelain`
 * blocks, each a `worktree <path>` line followed by its own `branch <ref>` line. A block carrying
 * a `prunable` line describes a worktree whose directory is gone (deleted without `git worktree
 * prune`), so it never counts as a live holder of the branch, wherever the line appears in it.
 */
function findWorktreeForBranch(git: GitService, repoDir: string, branch: string): string | null {
  const listed = git.worktreeList(repoDir)
  if (!listed.ok) return null
  for (const block of splitPorcelainBlocks(listed.stdout)) {
    if (block.some((line) => line.startsWith(PRUNABLE_PREFIX))) continue
    const worktreeLine = block.find((line) => line.startsWith(WORKTREE_PREFIX))
    if (!worktreeLine) continue
    if (!block.includes(`${BRANCH_PREFIX}${branch}`)) continue
    return worktreeLine.slice(WORKTREE_PREFIX.length)
  }
  return null
}

/**
 * The single wording for a branch that is already checked out in a worktree, shared by request
 * validation and the workspace adapter's create failure path.
 */
export function describeBranchInUse(branch: string, worktreePath: string): string {
  return `Branch ${branch} is checked out in worktree ${worktreePath}; choose another branch or free it`
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

type LoopBranchRequest = { branch?: string; baseRef?: string }

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
      return { ok: false, message: describeBranchInUse(branch, worktreePath) }
    }
  }

  if (branch && baseRef) {
    const conflict = describeBranchReuseConflict(git, repoDir, branch, baseRef)
    if (conflict !== null) return { ok: false, message: conflict }
  }

  return { ok: true }
}
