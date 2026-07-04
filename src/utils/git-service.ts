import { spawnSync } from 'child_process'

export interface GitResult {
  ok: boolean
  status: number
  stdout: string
  stderr: string
}

export interface GitService {
  addAll(cwd: string): GitResult
  /** True when `path` (file or directory) is tracked by git in `cwd`. */
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
  commitExists(cwd: string, sha: string): boolean
  push(cwd: string, remote: string, refspec: string, force: boolean): GitResult
  fetchRef(cwd: string, remote: string, ref: string): GitResult
  worktreeAdd(cwd: string, directory: string, branch: string, createBranch: boolean, startPoint?: string): GitResult
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

    commitExists(cwd: string, sha: string): boolean {
      return runGit(['cat-file', '-e', `${sha}^{commit}`], cwd).ok
    },

    push(cwd: string, remote: string, refspec: string, force: boolean): GitResult {
      const args = force ? ['push', '--force', remote, refspec] : ['push', remote, refspec]
      return runGit(args, cwd)
    },

    fetchRef(cwd: string, remote: string, ref: string): GitResult {
      return runGit(['fetch', remote, ref], cwd)
    },

    worktreeAdd(cwd: string, directory: string, branch: string, createBranch: boolean, startPoint?: string): GitResult {
      if (createBranch && startPoint) {
        return runGit(['worktree', 'add', directory, '-b', branch, startPoint], cwd)
      }
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
