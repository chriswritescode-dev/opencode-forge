import { join, resolve } from 'path'
import { mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { spawnSync, execSync } from 'child_process'
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

      // Resolve loopName from the workspace metadata. Falls back to info.name
      // when extra.loopName is missing (e.g., legacy workspaces) so teardown
      // is best-effort rather than throwing.
      let loopName: string
      try {
        loopName = deriveLoopName(info)
      } catch {
        loopName = info.name || 'unknown'
      }

      const ctx = getTeardownContext?.(loopName) ?? DEFAULT_TEARDOWN_CONTEXT

      // Derive a best-effort project directory for branch deletion.
      let projectDir: string | null = null
      const extra = (info.extra ?? {}) as { projectDirectory?: unknown }
      if (typeof extra.projectDirectory === 'string' && extra.projectDirectory) {
        projectDir = extra.projectDirectory
      } else if (existsSync(info.directory)) {
        try {
          const commonDir = execSync('git rev-parse --git-common-dir', { cwd: info.directory, encoding: 'utf-8' }).trim()
          projectDir = resolve(info.directory, commonDir, '..')
        } catch {
          projectDir = null
        }
      }

      // Step 1 (inverse of any worktree commits the loop made): commit pending
      // changes so the user can recover them from the renamed branch.
      if (ctx.doCommit && existsSync(info.directory)) {
        try {
          const addResult = spawnSync('git', ['add', '-A'], { cwd: info.directory, encoding: 'utf-8' })
          if (addResult.status !== 0) {
            logger.log(`forge-adapter: git add failed during teardown: ${addResult.stderr?.trim() || 'unknown error'}`)
          } else {
            const statusResult = spawnSync('git', ['status', '--porcelain'], { cwd: info.directory, encoding: 'utf-8' })
            if (statusResult.status === 0 && statusResult.stdout.trim()) {
              const iterations = ctx.iteration === 1 ? 'iteration' : 'iterations'
              const message = `loop: ${loopName} ${ctx.reasonLabel} after ${ctx.iteration} ${iterations}`
              const commitResult = spawnSync('git', ['commit', '-m', message], { cwd: info.directory, encoding: 'utf-8' })
              if (commitResult.status === 0) {
                logger.log(`forge-adapter: committed pending changes on ${info.branch ?? '<branch>'}`)
              } else {
                logger.log(`forge-adapter: commit failed on ${info.branch ?? '<branch>'}: ${commitResult.stderr?.trim() || 'unknown error'}`)
              }
            } else {
              logger.log(`forge-adapter: no pending changes to commit on ${info.branch ?? '<branch>'}`)
            }
          }
        } catch (err) {
          logger.error('forge-adapter: commit step threw during teardown', err)
        }
      }

      // Step 2 (preserve work for user discoverability): rename the worktree
      // branch to `opencode/<slug>`. Must happen BEFORE removing the worktree
      // since `git branch -m` needs a live working directory.
      //
      // Branches in the `forge/` namespace are intentionally skipped: those
      // are scratch branches that get hard-deleted in step 5. Custom branches
      // (anything outside `forge/`) are renamed to keep the history reachable.
      if (info.branch && existsSync(info.directory) && !info.branch.startsWith('forge/')) {
        const renameResult = await finalizeWorktreeBranch({
          worktreeDir: info.directory,
          currentBranch: info.branch,
          loopName,
          logger,
        })
        if (renameResult) {
          logger.log(`forge-adapter: renamed branch ${info.branch} -> ${renameResult.renamedTo}`)
        }
      }

      // Step 3 (inverse of create's sandbox start): stop the sandbox container.
      if (sandboxManager && info.name) {
        await sandboxManager.stop(info.name).catch((err) => {
          logger.log(`forge-adapter: sandbox stop during remove failed for ${info.name}: ${err instanceof Error ? err.message : String(err)}`)
        })
      }

      // Step 4 (inverse of `git worktree add`): remove the worktree directory
      // and prune dead worktree records. Delegates to the shared utility so
      // we share the already-removed / permission-denied edge cases.
      const cleanupResult = await cleanupLoopWorktree({
        worktreeDir: info.directory,
        logPrefix: 'forge-adapter',
        logger,
      })
      if (cleanupResult.error) {
        throw new Error(cleanupResult.error)
      }

      // Step 5 (inverse of `-b <branch>`): delete the forge/<loopName> branch.
      // Best-effort — the branch may have been renamed in step 2, may have
      // never been created, or may already be gone.
      if (info.branch && projectDir) {
        const branchRes = spawnSync('git', ['branch', '-D', info.branch], {
          cwd: projectDir,
          encoding: 'utf-8',
        })
        if (branchRes.status !== 0) {
          const stderr = branchRes.stderr?.trim() || ''
          if (stderr && !stderr.includes('not found')) {
            logger.log(`forge-adapter: could not delete branch ${info.branch}: ${stderr}`)
          }
        } else {
          logger.log(`forge-adapter: deleted branch ${info.branch}`)
        }
      } else if (info.branch) {
        logger.log(`forge-adapter: skipping branch delete for ${info.branch}: no projectDirectory and worktree already gone`)
      }
    },
    target(info) {
      return { type: 'local', directory: info.directory! }
    },
  }
}
