import { join } from 'path'
import { mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { spawnSync } from 'child_process'
import type { WorkspaceAdapter, WorkspaceInfo } from '@opencode-ai/plugin'
import type { Logger } from '../types'
import type { SandboxManager } from '../sandbox/manager'
import { slugify } from '../utils/logger'
import { cleanupLoopWorktree } from '../utils/worktree-cleanup'


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

      const addArgs = branchExists
        ? ['worktree', 'add', info.directory, info.branch]
        : ['worktree', 'add', info.directory, '-b', info.branch]

      let res = spawnSync('git', addArgs, { cwd: projectDir, encoding: 'utf-8' })
      let reusedOrphan = false
      if (res.status !== 0) {
        const stderr = res.stderr?.trim() || 'unknown error'
        const isAlreadyExists = /already exists/i.test(stderr) || /is already (checked out|registered)/i.test(stderr)
        if (isAlreadyExists && existsSync(info.directory)) {
          const existingBranch = spawnSync('git', ['branch', '--show-current'], { cwd: info.directory, encoding: 'utf-8' })
          if (existingBranch.status === 0 && existingBranch.stdout.trim() === info.branch) {
            logger.log(`forge-adapter: reusing existing worktree ${info.directory} on branch ${info.branch}`)
            reusedOrphan = true
          } else {
            logger.log(`forge-adapter: worktree directory ${info.directory} already exists; cleaning up orphan and retrying`)
            const cleanup = await cleanupLoopWorktree({
              worktreeDir: info.directory,
              logPrefix: 'forge-adapter:create:orphan-cleanup',
              logger,
            })
            if (!cleanup.removed) {
              logger.error(`forge-adapter: orphan cleanup failed for ${info.directory}: ${cleanup.error ?? 'unknown error'}`)
              throw new Error(`git worktree add failed: ${stderr}`)
            }
            res = spawnSync('git', addArgs, { cwd: projectDir, encoding: 'utf-8' })
            if (res.status !== 0) {
              const retryStderr = res.stderr?.trim() || 'unknown error'
              logger.error(`forge-adapter: git worktree add still failed after orphan cleanup: ${retryStderr}`)
              throw new Error(`git worktree add failed: ${retryStderr}`)
            }
            reusedOrphan = true
          }
        } else {
          logger.error(`forge-adapter: git worktree add failed: ${stderr}`)
          throw new Error(`git worktree add failed: ${stderr}`)
        }
      }
      logger.log(`forge-adapter: created worktree ${info.directory} on branch ${info.branch}${branchExists ? ' (reused existing branch)' : ''}${reusedOrphan ? ' (after orphan cleanup)' : ''}`)

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

      // Always commit changes so work isn't lost — skip only when the worktree
      // directory itself is already gone.
      await stepCommitChanges(loopName, info.directory, info.branch ?? '<branch>', ctx)

      // Stop sandbox container if running.
      await stepStopSandbox(sandboxManager, info.name)

      // Remove the worktree directory and prune dead records.
      // Skip on error/stall/abort so restart can reuse it.
      await stepRemoveWorktree(info.directory, ctx)

      // Branches are never deleted — `forge/*` scratch branches stay in place for potential restart.
    },
    target(info) {
      return { type: 'local', directory: info.directory! }
    },
  }
}
