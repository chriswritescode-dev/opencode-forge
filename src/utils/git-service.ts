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
  /** Resolves `ref` to its commit sha (`git rev-parse --verify <ref>^{commit}`); stdout is the sha. */
  revParse(cwd: string, ref: string): GitResult
  worktreeAdd(cwd: string, directory: string, branch: string, createBranch: boolean, startPoint?: string): GitResult
  /** Adds a detached worktree at `directory` checked out at `commit`. */
  worktreeAddDetached(cwd: string, directory: string, commit: string): GitResult
  worktreeList(cwd: string): GitResult
  worktreeRemove(cwd: string, directory: string): GitResult
  worktreePrune(cwd: string): GitResult
  branchDelete(cwd: string, branch: string): GitResult
  /** Runs `git check-ref-format --branch <name>`; stdout is the resolved branch name. */
  checkRefFormatBranch(cwd: string, name: string): GitResult
  /** True when `ancestor` is an ancestor of (or equal to) `descendant`. */
  isAncestor(cwd: string, ancestor: string, descendant: string): boolean
  /** Points `branch` at `startPoint`, moving it even when the move is not a fast-forward. */
  branchForceUpdate(cwd: string, branch: string, startPoint: string): GitResult
}

/**
 * Forge's git always runs on the host, while a sandboxed loop has read-write access to the
 * repository's git metadata (its worktree's git dir, and the common dir when it is mounted). A
 * repo-controlled hook — planted in `.git/hooks` or pointed at by `core.hooksPath` in the
 * repo-local config, neither of which the sandbox boundary can make read-only — would therefore
 * execute on the host with the user's privileges. Disabling hooksPath on every forge invocation
 * closes that path: forge's git calls are mechanical (status, scratch-branch snapshot commits,
 * worktree bookkeeping) and never depended on repository hooks.
 */
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

    worktreeAddDetached(cwd: string, directory: string, commit: string): GitResult {
      return runGit(['worktree', 'add', '--detach', directory, commit], cwd)
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
