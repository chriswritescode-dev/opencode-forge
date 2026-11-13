import { spawnSync } from 'child_process'

export interface GitResult {
  ok: boolean
  status: number
  stdout: string
  stderr: string
}

export interface GitService {
  addAll(cwd: string): GitResult
  removeFromIndex(cwd: string, path: string): GitResult
  isPathTracked(cwd: string, path: string): boolean
  statusPorcelain(cwd: string): GitResult
  commit(cwd: string, message: string): GitResult
  isInsideWorkTree(cwd: string): boolean
  branchExists(cwd: string, branch: string): boolean
  currentBranch(cwd: string): string | null
  revParseGitDir(cwd: string): GitResult
  revParseGitCommonDir(cwd: string): GitResult
  revParseGitPath(cwd: string, path: string): GitResult
  revParseHead(cwd: string): GitResult
  revParse(cwd: string, ref: string): GitResult
  worktreeAdd(cwd: string, directory: string, branch: string, createBranch: boolean, startPoint?: string): GitResult
  worktreeList(cwd: string): GitResult
  worktreeRemove(cwd: string, directory: string): GitResult
  worktreePrune(cwd: string): GitResult
  branchDelete(cwd: string, branch: string): GitResult
  checkRefFormatBranch(cwd: string, name: string): GitResult
  isAncestor(cwd: string, ancestor: string, descendant: string): boolean
  branchForceUpdate(cwd: string, branch: string, startPoint: string): GitResult
}

const HOOKS_DISABLED_ARGS = ['-c', 'core.hooksPath=/dev/null']

function runGit(args: string[], cwd: string): GitResult {
  const res = spawnSync('git', [...HOOKS_DISABLED_ARGS, ...args], { cwd, encoding: 'utf-8' })
  if (res.error) return { ok: false, status: -1, stdout: '', stderr: res.error.message }
  return { ok: res.status === 0, status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

export function createGitService(): GitService {
  return {
    addAll(cwd: string): GitResult {
      return runGit(['add', '-A'], cwd)
    },

    removeFromIndex(cwd: string, path: string): GitResult {
      return runGit(['rm', '--cached', '-q', '--ignore-unmatch', '--', path], cwd)
    },

    isPathTracked(cwd: string, path: string): boolean {
      const r = runGit(['ls-files', '--', path], cwd)
      return r.ok && r.stdout.trim().length > 0
    },

    statusPorcelain(cwd: string): GitResult {
      return runGit(['status', '--porcelain'], cwd)
    },

    commit(cwd: string, message: string): GitResult {
      return runGit(['commit', '-m', message], cwd)
    },

    isInsideWorkTree(cwd: string): boolean {
      const r = runGit(['rev-parse', '--is-inside-work-tree'], cwd)
      return r.ok && r.stdout.trim() === 'true'
    },

    branchExists(cwd: string, branch: string): boolean {
      if (!cwd || !branch) return false
      return runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], cwd).ok
    },

    currentBranch(cwd: string): string | null {
      const r = runGit(['branch', '--show-current'], cwd)
      return r.ok ? r.stdout.trim() : null
    },

    revParseGitDir(cwd: string): GitResult {
      return runGit(['rev-parse', '--git-dir'], cwd)
    },

    revParseGitCommonDir(cwd: string): GitResult {
      return runGit(['rev-parse', '--git-common-dir'], cwd)
    },

    revParseGitPath(cwd: string, path: string): GitResult {
      return runGit(['rev-parse', '--git-path', path], cwd)
    },

    revParseHead(cwd: string): GitResult {
      return runGit(['rev-parse', 'HEAD'], cwd)
    },

    revParse(cwd: string, ref: string): GitResult {
      return runGit(['rev-parse', '--verify', `${ref}^{commit}`], cwd)
    },

    worktreeAdd(cwd: string, directory: string, branch: string, createBranch: boolean, startPoint?: string): GitResult {
      if (!createBranch) return runGit(['worktree', 'add', directory, branch], cwd)
      return runGit(startPoint ? ['worktree', 'add', directory, '-b', branch, startPoint] : ['worktree', 'add', directory, '-b', branch], cwd)
    },

    worktreeList(cwd: string): GitResult {
      return runGit(['worktree', 'list', '--porcelain'], cwd)
    },

    worktreeRemove(cwd: string, directory: string): GitResult {
      return runGit(['worktree', 'remove', '-f', directory], cwd)
    },

    worktreePrune(cwd: string): GitResult {
      return runGit(['worktree', 'prune'], cwd)
    },

    branchDelete(cwd: string, branch: string): GitResult {
      return runGit(['branch', '-D', branch], cwd)
    },

    checkRefFormatBranch(cwd: string, name: string): GitResult {
      return runGit(['check-ref-format', '--branch', name], cwd)
    },

    isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
      return runGit(['merge-base', '--is-ancestor', ancestor, descendant], cwd).ok
    },

    branchForceUpdate(cwd: string, branch: string, startPoint: string): GitResult {
      return runGit(['branch', '-f', branch, startPoint], cwd)
    },
  }
}

export const defaultGitService: GitService = createGitService()
