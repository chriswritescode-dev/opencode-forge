import { join } from 'path'
import { mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { spawnSync } from 'child_process'
import type { WorkspaceAdapter, WorkspaceInfo } from '@opencode-ai/plugin'
import type { Logger } from '../types'
import type { SandboxManager } from '../sandbox/manager'
import { slugify } from '../utils/logger'
import { cleanupLoopWorktree } from '../utils/worktree-cleanup'
import { finalizeWorktreeBranch } from '../utils/worktree-branch'

/**
 * Runtime context for a forge workspace teardown. Populated by the caller
 * (loop termination side-effects, etc.) before `experimental.workspace.remove`
 * is invoked so the adapter can produce informative commit messages.
 *
 * When no context is registered (orphan sweep, TUI delete without an active
 * loop), the adapter falls back to sensible defaults.
 */
export interface TeardownContext {
  iteration: number
  reasonLabel: string
  doCommit: boolean
  /** When false the worktree directory stays in place for restart. */
  doRemoveWorktree: boolean
  /** When false the branch is preserved for restart. */
  doDeleteBranch: boolean
}

export type TeardownContextProvider = (loopName: string) => TeardownContext | undefined

export interface ForgeAdapterDeps {
  dataDir: string
  logger: Logger
  sandboxManager?: Pick<SandboxManager, 'start' | 'stop'> | null
  /**
   * Lookup runtime teardown context (iteration, reason, doCommit) for a loop.
   * Optional: when absent or returning undefined, the adapter uses defaults.
   */
  getTeardownContext?: TeardownContextProvider
}

const DEFAULT_TEARDOWN_CONTEXT: TeardownContext = {
  iteration: 0,
  reasonLabel: 'removed',
  doCommit: true,
  doRemoveWorktree: true,
  doDeleteBranch: true,
}

export function createForgeWorkspaceAdapter(deps: ForgeAdapterDeps): WorkspaceAdapter {
  const { dataDir, logger, sandboxManager, getTeardownContext } = deps

  function deriveLoopName(info: WorkspaceInfo): string {
    const extra = (info.extra ?? {}) as { loopName?: unknown }
    const raw = typeof extra.loopName === 'string' ? extra.loopName : ''
    if (!raw) throw new Error('forge workspace adapter: extra.loopName is required')
    return slugify(raw).slice(0, 60)
  }

  function deriveProjectDirectory(info: WorkspaceInfo): string {
    const extra = (info.extra ?? {}) as { projectDirectory?: unknown }
    const dir = typeof extra.projectDirectory === 'string' ? extra.projectDirectory : ''
    if (!dir) throw new Error('forge workspace adapter: extra.projectDirectory is required')
    return dir
  }

  function resolveLoopName(info: WorkspaceInfo): string {
    try {
      return deriveLoopName(info)
    } catch {
      return info.name || 'unknown'
    }
  }

  function resolveProjectDir(info: WorkspaceInfo): string | null {
    const extra = (info.extra ?? {}) as { projectDirectory?: unknown }
    if (typeof extra.projectDirectory === 'string' && extra.projectDirectory) {
      return extra.projectDirectory
    }
    if (!info.directory || !existsSync(info.directory)) return null
    try {
      const commonDir = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: info.directory, encoding: 'utf-8' }).stdout?.trim()
      if (commonDir) {
        return join(info.directory, commonDir, '..')
      }
    } catch {}
    return null
  }

  async function stepCommitChanges(loopName: string, directory: string, branchLabel: string, ctx: TeardownContext): Promise<void> {
    if (!ctx.doCommit || !existsSync(directory)) return

    try {
      const addResult = spawnSync('git', ['add', '-A'], { cwd: directory, encoding: 'utf-8' })
      if (addResult.status !== 0) {
        logger.log(`forge-adapter: git add failed during teardown: ${addResult.stderr?.trim() || 'unknown error'}`)
        return
      }

      const statusResult = spawnSync('git', ['status', '--porcelain'], { cwd: directory, encoding: 'utf-8' })
      if (statusResult.status !== 0 || !statusResult.stdout.trim()) {
        logger.log(`forge-adapter: no pending changes to commit on ${branchLabel}`)
        return
      }

      const iterLabel = ctx.iteration === 1 ? 'iteration' : 'iterations'
      const message = `loop: ${loopName} ${ctx.reasonLabel} after ${ctx.iteration} ${iterLabel}`
      const commitResult = spawnSync('git', ['commit', '-m', message], { cwd: directory, encoding: 'utf-8' })

      if (commitResult.status === 0) {
        logger.log(`forge-adapter: committed pending changes on ${branchLabel}`)
      } else {
        logger.log(`forge-adapter: commit failed on ${branchLabel}: ${commitResult.stderr?.trim() || 'unknown error'}`)
      }
    } catch (err) {
      logger.error('forge-adapter: commit step threw during teardown', err)
    }
  }

  async function stepRenameBranch(loopName: string, branch: string | null | undefined, worktreeDir: string): Promise<void> {
    if (!branch || !existsSync(worktreeDir) || branch.startsWith('forge/')) return

    const result = await finalizeWorktreeBranch({
      worktreeDir,
      currentBranch: branch,
      loopName,
      logger,
    })
    if (result) {
      logger.log(`forge-adapter: renamed branch ${branch} -> ${result.renamedTo}`)
    }
  }

  async function stepStopSandbox(sandboxManager: Pick<SandboxManager, 'start' | 'stop'> | null | undefined, name: string | undefined): Promise<void> {
    if (!sandboxManager || !name) return

    await sandboxManager.stop(name).catch((err) => {
      logger.log(`forge-adapter: sandbox stop failed for ${name}: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  async function stepRemoveWorktree(worktreeDir: string, ctx: TeardownContext): Promise<void> {
    if (!ctx.doRemoveWorktree) return

    const result = await cleanupLoopWorktree({
      worktreeDir,
      logPrefix: 'forge-adapter',
      logger,
    })
    if (result.error) {
      throw new Error(result.error)
    }
  }

  function stepDeleteBranch(branch: string | undefined, projectDir: string | undefined): void {
    if (!branch || !projectDir) return

    const res = spawnSync('git', ['branch', '-D', branch], { cwd: projectDir, encoding: 'utf-8' })
    if (res.status === 0) {
      logger.log(`forge-adapter: deleted branch ${branch}`)
      return
    }

    const stderr = res.stderr?.trim() || ''
    if (stderr && !stderr.includes('not found')) {
      logger.log(`forge-adapter: could not delete branch ${branch}: ${stderr}`)
    }
  }

  return {
    name: 'Forge Worktree',
    description: 'Named git worktree under the forge data directory',
    configure(info) {
      const loopName = deriveLoopName(info)
      return {
        ...info,
        name: loopName,
        branch: `forge/${loopName}`,
        directory: join(dataDir, 'worktrees', loopName),
      }
    },
    async create(info) {
      if (!info.directory || !info.branch) {
        throw new Error('forge workspace adapter: configure must set directory and branch')
      }
      const projectDir = deriveProjectDirectory(info)
      await mkdir(join(dataDir, 'worktrees'), { recursive: true })

      const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectDir, encoding: 'utf-8' })
      if (probe.status !== 0 || probe.stdout.trim() !== 'true') {
        throw new Error(`forge workspace adapter: projectDirectory ${projectDir} is not a git work tree`)
      }

      // Detect orphan state from a prior failed run: branch may exist without a live worktree.
      const branchExists = spawnSync(
        'git',
        ['show-ref', '--verify', '--quiet', `refs/heads/${info.branch}`],
        { cwd: projectDir, encoding: 'utf-8' },
      ).status === 0

      // Prune dead worktree records first so `git worktree add` can re-use an orphaned branch.
      spawnSync('git', ['worktree', 'prune'], { cwd: projectDir, encoding: 'utf-8' })

      const args = branchExists
        ? ['worktree', 'add', info.directory, info.branch]
        : ['worktree', 'add', info.directory, '-b', info.branch]

      const res = spawnSync('git', args, { cwd: projectDir, encoding: 'utf-8' })
      if (res.status !== 0) {
        const stderr = res.stderr?.trim() || 'unknown error'
        logger.error(`forge-adapter: git worktree add failed: ${stderr}`)
        throw new Error(`git worktree add failed: ${stderr}`)
      }
      logger.log(`forge-adapter: created worktree ${info.directory} on branch ${info.branch}${branchExists ? ' (reused existing branch)' : ''}`)

      if (sandboxManager) {
        try {
          const startedAt = new Date().toISOString()
          const sandbox = await sandboxManager.start(info.name, info.directory, startedAt)
          logger.log(`forge-adapter: sandbox container ${sandbox.containerName} started for ${info.name}`)
        } catch (err) {
          logger.error(`forge-adapter: sandbox provisioning failed for ${info.name}`, err)
          await sandboxManager.stop(info.name).catch((stopErr) => {
            logger.error(`forge-adapter: failed to stop sandbox after provisioning failure for ${info.name}`, stopErr)
          })
          if (existsSync(info.directory)) {
            const cleanup = spawnSync('git', ['worktree', 'remove', '-f', info.directory], {
              cwd: projectDir,
              encoding: 'utf-8',
            })
            if (cleanup.status !== 0) {
              logger.error(`forge-adapter: failed to remove worktree after sandbox failure: ${cleanup.stderr?.trim() || 'unknown error'}`)
            }
          }
          spawnSync('git', ['worktree', 'prune'], { cwd: projectDir, encoding: 'utf-8' })
          throw err
        }
      }
    },
    async remove(info) {
      if (!info.directory) return

      const loopName = resolveLoopName(info)
      const ctx = getTeardownContext?.(loopName) ?? DEFAULT_TEARDOWN_CONTEXT
      const projectDir = resolveProjectDir(info)

      // Always commit changes so work isn't lost — skip only when the worktree
      // directory itself is already gone.
      await stepCommitChanges(loopName, info.directory, info.branch ?? '<branch>', ctx)

      // Rename non-forge branches to opencode/<slug> before removal.
      await stepRenameBranch(loopName, info.branch, info.directory)

      // Stop sandbox container if running.
      await stepStopSandbox(sandboxManager, info.name)

      // Remove the worktree directory and prune dead records.
      // Skip on error/stall/abort so restart can reuse it.
      await stepRemoveWorktree(info.directory, ctx)

      // Only delete scratch branches (`forge/*`) — they have no meaningful
      // history. Non-forge branches were renamed to `opencode/*` above.
      // Skip on error/stall/abort so restart can use them.
      if (!info.branch?.startsWith('forge/') || !ctx.doDeleteBranch) return
      stepDeleteBranch(info.branch, projectDir ?? undefined)
    },
    target(info) {
      return { type: 'local', directory: info.directory! }
    },
  }
}
