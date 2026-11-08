import { dirname, join } from 'path'
import { existsSync, mkdirSync, readdirSync, rmSync, type Dirent } from 'fs'
import type { Logger } from '../types'
import { defaultGitService, type GitResult, type GitService } from '../utils/git-service'
import { forgeLaneBranchName, forgeLaneDir, forgeLanesDir, forgeWorktreeSlug } from '../workspace/forge-naming'
import { commitWorktreeChanges } from '../workspace/worktree-commit'
import { cleanupLoopWorktree } from '../utils/worktree-cleanup'

/** A section lane checked out beside the loop worktree it belongs to. */
export interface Lane {
  laneDir: string
  laneBranch: string
  baseCommit: string
}

/** Outcome of merging a lane branch back into the loop worktree. */
export type LaneMergeResult =
  | { kind: 'merged'; commit: string }
  | { kind: 'conflict'; files: string[] }
  | { kind: 'failed'; error: string }

function gitFailure(prefix: string, result: GitResult): Error {
  return new Error(`${prefix}: ${result.stderr.trim() || 'unknown error'}`)
}

/**
 * Creates (or re-creates) a lane worktree for `sectionId` from the loop
 * worktree's current head. A surviving lane branch is force-updated to that
 * head so a retried section starts from the loop tip instead of stale work.
 */
export function createLane(input: {
  git: GitService
  logger: Logger
  loopName: string
  worktreeDir: string
  sectionId: string
  prepare?: (laneDir: string) => void
}): Lane {
  const head = input.git.revParseHead(input.worktreeDir)
  if (!head.ok) throw gitFailure(`lanes: could not resolve HEAD of ${input.worktreeDir}`, head)
  const baseCommit = head.stdout.trim()

  const laneDir = forgeLaneDir(input.worktreeDir, input.sectionId)
  const laneBranch = forgeLaneBranchName(input.loopName, input.sectionId)
  mkdirSync(dirname(laneDir), { recursive: true })

  let addResult: GitResult
  if (input.git.branchExists(input.worktreeDir, laneBranch)) {
    const updateResult = input.git.branchForceUpdate(input.worktreeDir, laneBranch, baseCommit)
    if (!updateResult.ok) throw gitFailure(`lanes: could not reset branch ${laneBranch}`, updateResult)
    addResult = input.git.worktreeAdd(input.worktreeDir, laneDir, laneBranch, false)
  } else {
    addResult = input.git.worktreeAdd(input.worktreeDir, laneDir, laneBranch, true, baseCommit)
  }
  if (!addResult.ok) throw gitFailure(`lanes: could not add worktree ${laneDir}`, addResult)

  input.prepare?.(laneDir)
  input.logger.log(`lanes: created ${laneBranch} at ${laneDir} from ${baseCommit}`)

  return { laneDir, laneBranch, baseCommit }
}

/**
 * Commits the lane's pending work and merges its branch into the loop
 * worktree. A conflicted merge is aborted in the loop worktree, which must be
 * restored to its pre-merge head; the conflicting merge is then replayed inside
 * the lane so the section runs can resolve it there.
 */
export function mergeLane(input: {
  git: GitService
  logger: Logger
  worktreeDir: string
  laneDir: string
  laneBranch: string
  title: string
}): LaneMergeResult {
  const preMergeHead = input.git.revParseHead(input.worktreeDir)
  if (!preMergeHead.ok) {
    return { kind: 'failed', error: gitFailure(`lanes: could not resolve HEAD of ${input.worktreeDir}`, preMergeHead).message }
  }
  const preMergeSha = preMergeHead.stdout.trim()

  const commitOutcome = commitWorktreeChanges(input.git, input.logger, input.laneDir, input.title)
  if (commitOutcome === 'failed') {
    return { kind: 'failed', error: `could not commit lane ${input.laneDir}` }
  }

  const mergeResult = input.git.merge(input.worktreeDir, input.laneBranch, `Merge section: ${input.title}`)
  if (mergeResult.ok) {
    const postMergeHead = input.git.revParseHead(input.worktreeDir)
    const commit = postMergeHead.ok ? postMergeHead.stdout.trim() : preMergeSha
    input.logger.log(`lanes: merged ${input.laneBranch} into ${input.worktreeDir} at ${commit}`)
    return { kind: 'merged', commit }
  }

  const abortResult = input.git.mergeAbort(input.worktreeDir)
  if (!abortResult.ok) {
    return { kind: 'failed', error: gitFailure(`lanes: could not abort merge in ${input.worktreeDir}`, abortResult).message }
  }

  const restoredHead = input.git.revParseHead(input.worktreeDir)
  const restoredStatus = input.git.statusPorcelain(input.worktreeDir)
  if (
    !restoredHead.ok ||
    restoredHead.stdout.trim() !== preMergeSha ||
    !restoredStatus.ok ||
    restoredStatus.stdout.trim() !== ''
  ) {
    return {
      kind: 'failed',
      error: `lanes: loop worktree ${input.worktreeDir} was not restored after aborting merge of ${input.laneBranch}`,
    }
  }

  input.git.mergeIntoWorktree(input.laneDir, preMergeSha)

  const unmerged = input.git.listUnmergedFiles(input.laneDir)
  if (!unmerged.ok) {
    return { kind: 'failed', error: gitFailure(`lanes: could not list unmerged files in ${input.laneDir}`, unmerged).message }
  }
  const files = unmerged.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  input.logger.log(`lanes: ${input.laneBranch} conflicts in ${files.join(', ')}`)
  return { kind: 'conflict', files }
}

/**
 * Removes a lane worktree and its branch, then prunes the shared worktree
 * registry. Cleanup and delete failures are logged, never thrown.
 */
export async function removeLane(input: {
  git: GitService
  logger: Logger
  worktreeDir: string
  laneDir: string
  laneBranch: string
}): Promise<void> {
  const result = await cleanupLoopWorktree({
    worktreeDir: input.laneDir,
    logPrefix: 'lanes',
    logger: input.logger,
    git: input.git,
  })
  if (result.error) {
    input.logger.log(`lanes: could not remove worktree ${input.laneDir}: ${result.error}`)
  }

  const deleteResult = input.git.branchDelete(input.worktreeDir, input.laneBranch)
  if (!deleteResult.ok) {
    input.logger.log(`lanes: could not delete branch ${input.laneBranch}: ${deleteResult.stderr.trim() || 'unknown error'}`)
  }

  input.git.worktreePrune(input.worktreeDir)
}

/**
 * Removes every lane of a loop: lane worktrees, lane branches (including ones
 * whose directory is already gone), and the lanes root directory.
 */
export async function removeLoopLanes(input: {
  git: GitService
  logger: Logger
  worktreeDir: string
  loopName: string
}): Promise<void> {
  const lanesDir = forgeLanesDir(input.worktreeDir)

  let entries: Dirent[]
  try {
    entries = readdirSync(lanesDir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      entries = []
    } else {
      throw err
    }
  }

  for (const entry of entries) {
    await removeLane({
      git: input.git,
      logger: input.logger,
      worktreeDir: input.worktreeDir,
      laneDir: join(lanesDir, entry.name),
      laneBranch: forgeLaneBranchName(input.loopName, entry.name),
    })
  }

  const branches = input.git.listBranches(input.worktreeDir, `forge-lane/${forgeWorktreeSlug(input.loopName)}/*`)
  if (branches.ok) {
    for (const branch of branches.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)) {
      const deleteResult = input.git.branchDelete(input.worktreeDir, branch)
      if (!deleteResult.ok) {
        input.logger.log(`lanes: could not delete branch ${branch}: ${deleteResult.stderr.trim() || 'unknown error'}`)
      }
    }
  }

  rmSync(lanesDir, { recursive: true, force: true })
  input.git.worktreePrune(input.worktreeDir)
}

/** True when `laneDir` exists and is a checkout inside a git work tree. */
export function laneExists(laneDir: string, git: GitService = defaultGitService): boolean {
  return existsSync(laneDir) && git.isInsideWorkTree(laneDir)
}
