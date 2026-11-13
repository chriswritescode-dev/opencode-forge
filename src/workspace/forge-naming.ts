import { join, relative, isAbsolute, sep } from 'path'
import { readdirSync } from 'fs'
import { z } from 'zod'
import { slugify } from '../utils/logger'
import { defaultGitService, type GitService } from '../utils/git-service'

export function forgeWorktreeSlug(loopName: string): string {
  return slugify(loopName)
}

export function forgeBranchName(loopName: string): string {
  return `forge/${forgeWorktreeSlug(loopName)}`
}

export function resolveLoopBranchName(loopName: string, explicitBranch?: string | null): string {
  return explicitBranch !== undefined && explicitBranch !== null && explicitBranch.length > 0
    ? explicitBranch
    : forgeBranchName(loopName)
}

export function forgeWorktreesRoot(dataDir: string): string {
  return join(dataDir, 'worktrees')
}

export function forgeWorktreeDir(dataDir: string, loopName: string): string {
  return join(forgeWorktreesRoot(dataDir), forgeWorktreeSlug(loopName))
}

const errnoExceptionSchema = z.looseObject({ code: z.string().optional() })

export function listForgeWorktreeDirs(dataDir: string): string[] {
  const root = forgeWorktreesRoot(dataDir)
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
  } catch (cause) {
    const parsed = errnoExceptionSchema.safeParse(cause)
    if (parsed.success && parsed.data.code === 'ENOENT') return []
    throw cause
  }
}

export function isWithinDir(root: string, directory: string): boolean {
  if (!root || !directory) return false
  const rel = relative(root, directory)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export function isForgeWorktreeDir(dataDir: string, directory: string): boolean {
  return isWithinDir(forgeWorktreesRoot(dataDir), directory)
}

export function gitBranchExists(repoDir: string, branch: string, git: GitService = defaultGitService): boolean {
  if (!repoDir || !branch) return false
  return git.branchExists(repoDir, branch)
}

export function loopBranchExists(
  state: { loopName: string; worktreeBranch?: string | null; projectDir?: string | null },
  fallbackDir: string,
  git: GitService = defaultGitService,
): boolean {
  const repoDir = state.projectDir || fallbackDir
  const branch = resolveLoopBranchName(state.loopName, state.worktreeBranch)
  return gitBranchExists(repoDir, branch, git)
}
