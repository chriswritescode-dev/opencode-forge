import { spawnSync } from 'child_process'

export interface GitResult {
  ok: boolean
  status: number
  stdout: string
  stderr: string
}

export interface GitService {
  addAll(cwd: string): GitResult
  statusPorcelain(cwd: string): GitResult
  commit(cwd: string, message: string): GitResult
  isInsideWorkTree(cwd: string): boolean
  branchExists(cwd: string, branch: string): boolean
  currentBranch(cwd: string): string | null
  revParseGitDir(cwd: string): GitResult
  revParseGitCommonDir(cwd: string): GitResult
  revParseGitPath(cwd: string, path: string): GitResult
  worktreeAdd(cwd: string, directory: string, branch: string, createBranch: boolean): GitResult
  worktreeRemove(cwd: string, directory: string): GitResult
  worktreePrune(cwd: string): GitResult
}

function runGit(args: string[], cwd: string): GitResult {
  const res = spawnSync('git', args, { cwd, encoding: 'utf-8' })
  if (res.error) return { ok: false, status: -1, stdout: '', stderr: res.error.message }
  return { ok: res.status === 0, status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

export function createGitService(): GitService {
  return {
    addAll(cwd: string): GitResult {
      return runGit(['add', '-A'], cwd)
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

    worktreeAdd(cwd: string, directory: string, branch: string, createBranch: boolean): GitResult {
      return runGit(createBranch ? ['worktree', 'add', directory, '-b', branch] : ['worktree', 'add', directory, branch], cwd)
    },

    worktreeRemove(cwd: string, directory: string): GitResult {
      return runGit(['worktree', 'remove', '-f', directory], cwd)
    },

    worktreePrune(cwd: string): GitResult {
      return runGit(['worktree', 'prune'], cwd)
    },
  }
}

export const defaultGitService: GitService = createGitService()
