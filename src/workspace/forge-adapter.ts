import { join } from 'path'
import { mkdir } from 'fs/promises'
import { existsSync, readFileSync, appendFileSync, rmSync } from 'fs'
import type { WorkspaceAdapter, WorkspaceInfo } from '@opencode-ai/plugin'
import type { Logger } from '../types'
import type { SandboxManager } from '../sandbox/manager'
import { forgeBranchName, forgeWorktreeDir, forgeWorktreeSlug } from './forge-naming'
import { cleanupLoopWorktree } from '../utils/worktree-cleanup'
import { defaultGitService, type GitService } from '../utils/git-service'
import { forgeSyncRef, DEFAULT_GIT_REMOTE } from '../utils/remote-config'
import { writeWorktreeOpencodeConfig, WORKTREE_OPENCODE_CONFIG_FILENAME } from './worktree-opencode-config'
import { sandboxContainerName } from '../sandbox/docker'


/**
 * Runtime context for a forge workspace teardown. Populated by the caller
 * (loop termination side-effects, etc.) before `client.workspace.remove`
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
  /** Inject a custom GitService (defaults to real git if omitted). */
  gitService?: GitService
  /** Inline opencode config written as opencode.jsonc into each worktree (skip-if-exists). */
  worktreeOpencodeConfig?: Record<string, unknown>
}

const DEFAULT_TEARDOWN_CONTEXT: TeardownContext = {
  iteration: 0,
  reasonLabel: 'removed',
  doCommit: true,
  doRemoveWorktree: true,
}

export function createForgeWorkspaceAdapter(deps: ForgeAdapterDeps): WorkspaceAdapter {
  const { dataDir, logger, sandboxManager, getTeardownContext, gitService: gitServiceOpt, worktreeOpencodeConfig } = deps
  const git = gitServiceOpt ?? defaultGitService

  function deriveLoopName(info: WorkspaceInfo): string {
    const extra = (info.extra ?? {}) as { loopName?: unknown }
    const raw = typeof extra.loopName === 'string' ? extra.loopName : ''
    if (!raw) throw new Error('forge workspace adapter: extra.loopName is required')
    return forgeWorktreeSlug(raw)
  }

  function deriveProjectDirectory(info: WorkspaceInfo): string {
    const extra = (info.extra ?? {}) as { projectDirectory?: unknown }
    const dir = typeof extra.projectDirectory === 'string' ? extra.projectDirectory : ''
    if (!dir) throw new Error('forge workspace adapter: extra.projectDirectory is required')
    return dir
  }

  /**
   * Whether this workspace's loop explicitly opted out of the sandbox
   * (`extra.forgeLoop.sandboxEnabled === false`), e.g. a remote launch with
   * `remotes[].sandbox: false`. Provisioning must honor the per-loop flag even
   * when this server's own config has the sandbox enabled.
   */
  function isLoopSandboxOptedOut(info: WorkspaceInfo): boolean {
    const forgeLoop = ((info.extra ?? {}) as { forgeLoop?: unknown }).forgeLoop
    if (typeof forgeLoop !== 'object' || forgeLoop === null) return false
    return (forgeLoop as { sandboxEnabled?: unknown }).sandboxEnabled === false
  }

  function addToGitExclude(directory: string, patterns: string[]): void {
    if (patterns.length === 0) return
    const excludeRes = git.revParseGitPath(directory, 'info/exclude')
    if (!excludeRes.ok || !excludeRes.stdout) return
    const excludeFile = excludeRes.stdout.trim()
    try {
      const content = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf-8') : ''
      const present = new Set(content.split('\n').map((l) => l.trim()))
      const missing = patterns.filter((p) => !present.has(p))
      if (missing.length > 0) {
        appendFileSync(excludeFile, `\n${missing.join('\n')}\n`)
        logger.log(`forge-adapter: added ${missing.join(', ')} to git exclude in ${directory}`)
      }
    } catch (err) {
      logger.log(`forge-adapter: could not update git exclude: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function resolveLoopName(info: WorkspaceInfo): string {
    try {
      return deriveLoopName(info)
    } catch {
      return info.name || 'unknown'
    }
  }

  /**
   * Remove the forge-written `opencode.jsonc` before a teardown commit so the
   * inline per-loop config never enters loop history. Only an untracked file is
   * removed: when the repository already tracks an `opencode.jsonc`, forge never
   * wrote it (skip-if-exists), so it is left untouched and its edits still commit.
   * The worktree itself is torn down at teardown, so the removed file is not lost.
   */
  function removeForgeWrittenOpencodeConfig(directory: string): void {
    const configPath = join(directory, WORKTREE_OPENCODE_CONFIG_FILENAME)
    if (!existsSync(configPath)) return
    if (git.isPathTracked(directory, WORKTREE_OPENCODE_CONFIG_FILENAME)) return
    try {
      rmSync(configPath, { force: true })
      logger.log(`forge-adapter: removed forge-written ${WORKTREE_OPENCODE_CONFIG_FILENAME} before commit in ${directory}`)
    } catch (err) {
      logger.log(`forge-adapter: could not remove ${WORKTREE_OPENCODE_CONFIG_FILENAME}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function stepCommitChanges(loopName: string, directory: string, branchLabel: string, ctx: TeardownContext): Promise<void> {
    if (!ctx.doCommit || !existsSync(directory)) return

    removeForgeWrittenOpencodeConfig(directory)

    try {
      const addResult = git.addAll(directory)
      if (!addResult.ok) {
        logger.log(`forge-adapter: git add failed during teardown: ${addResult.stderr.trim() || 'unknown error'}`)
        return
      }

      const statusResult = git.statusPorcelain(directory)
      if (!statusResult.ok || !statusResult.stdout.trim()) {
        logger.log(`forge-adapter: no pending changes to commit on ${branchLabel}`)
        return
      }

      const iterLabel = ctx.iteration === 1 ? 'iteration' : 'iterations'
      const message = `loop: ${loopName} ${ctx.reasonLabel} after ${ctx.iteration} ${iterLabel}`
      const commitResult = git.commit(directory, message)

      if (commitResult.ok) {
        logger.log(`forge-adapter: committed pending changes on ${branchLabel}`)
      } else {
        logger.log(`forge-adapter: commit failed on ${branchLabel}: ${commitResult.stderr.trim() || 'unknown error'}`)
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

  /**
   * Re-stamp launcher-provided attach timestamps with this server's clock.
   *
   * Remote launches stamp `workspaceCreatedAt` and
   * `forgeLoop.pendingAttachStartedAt` on the launching machine, but the
   * attach/pending-start grace windows are evaluated against this server's
   * clock (classify-stale.ts). Clock skew between the two machines beyond the
   * grace window would otherwise expire a fresh workspace immediately.
   * `configure` runs exactly once at creation on the owning server, so it is
   * the single normalization point.
   */
  function restampAttachTimestamps(extra: unknown): unknown {
    if (typeof extra !== 'object' || extra === null) return extra
    const now = Date.now()
    const record = extra as Record<string, unknown>
    const result: Record<string, unknown> = { ...record, workspaceCreatedAt: now }
    const forgeLoop = record.forgeLoop
    if (
      typeof forgeLoop === 'object' &&
      forgeLoop !== null &&
      typeof (forgeLoop as Record<string, unknown>).pendingAttachStartedAt === 'number'
    ) {
      result.forgeLoop = { ...(forgeLoop as Record<string, unknown>), pendingAttachStartedAt: now }
    }
    return result
  }

  function deriveSyncPin(info: WorkspaceInfo, loopName: string): { startRef: string; syncRef: string; gitRemote: string } | null {
    const extra = (info.extra ?? {}) as Record<string, unknown>
    const startRef = typeof extra.startRef === 'string' && extra.startRef.length > 0 ? extra.startRef : null
    if (!startRef) return null
    const syncRef = typeof extra.syncRef === 'string' ? extra.syncRef : forgeSyncRef(loopName)
    const gitRemote = typeof extra.gitRemote === 'string' ? extra.gitRemote : DEFAULT_GIT_REMOTE
    return { startRef, syncRef, gitRemote }
  }

  async function stepRemoveWorktree(worktreeDir: string, ctx: TeardownContext): Promise<void> {
    if (!ctx.doRemoveWorktree) return

    const result = await cleanupLoopWorktree({
      worktreeDir,
      logPrefix: 'forge-adapter',
      logger,
      git,
    })
    if (result.error) {
      throw new Error(result.error)
    }
  }

  /**
   * Best-effort deletion of the remote-launch sync ref (`refs/forge/<loop>`)
   * on the shared git remote so refs do not accumulate there. Runs only on
   * final teardown (worktree removed): the loop branch pins the fetched
   * commit locally, so the shared ref is no longer needed. Restart-preserving
   * teardowns keep the ref in place.
   */
  function stepDeleteSyncRef(info: WorkspaceInfo, loopName: string, ctx: TeardownContext): void {
    if (!ctx.doRemoveWorktree) return
    const pin = deriveSyncPin(info, loopName)
    if (!pin) return
    try {
      const projectDir = deriveProjectDirectory(info)
      const res = git.push(projectDir, pin.gitRemote, `:${pin.syncRef}`, false)
      if (res.ok) {
        logger.log(`forge-adapter: deleted sync ref ${pin.syncRef} on ${pin.gitRemote}`)
      } else {
        logger.log(`forge-adapter: could not delete sync ref ${pin.syncRef} on ${pin.gitRemote}: ${res.stderr.trim() || 'unknown error'}`)
      }
    } catch (err) {
      logger.log(`forge-adapter: sync ref cleanup skipped: ${err instanceof Error ? err.message : String(err)}`)
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
        branch: forgeBranchName(loopName),
        directory: forgeWorktreeDir(dataDir, loopName),
        extra: restampAttachTimestamps(info.extra),
      }
    },
    async create(info) {
      if (!info.directory || !info.branch) {
        throw new Error('forge workspace adapter: configure must set directory and branch')
      }
      const projectDir = deriveProjectDirectory(info)
      await mkdir(join(dataDir, 'worktrees'), { recursive: true })

      if (!git.isInsideWorkTree(projectDir)) {
        throw new Error(`forge workspace adapter: projectDirectory ${projectDir} is not a git work tree`)
      }

      // Resolve SHA pin before checking branch existence so the fetch (if needed)
      // happens before any worktree operation.
      const loopName = deriveLoopName(info)
      const pin = deriveSyncPin(info, loopName)
      if (pin && !git.commitExists(projectDir, pin.startRef)) {
        logger.log(`forge-adapter: fetching ${pin.syncRef} from ${pin.gitRemote} to resolve pinned SHA ${pin.startRef}`)
        git.fetchRef(projectDir, pin.gitRemote, pin.syncRef)
        if (!git.commitExists(projectDir, pin.startRef)) {
          throw new Error(
            `forge workspace adapter: startRef ${pin.startRef} not found after fetching ${pin.syncRef} from ${pin.gitRemote}`,
          )
        }
      }

      // Detect orphan state from a prior failed run: branch may exist without a live worktree.
      const branchExists = git.branchExists(projectDir, info.branch)

      // A pinned launch must run exactly the pushed SHA. Reusing a leftover
      // same-named branch at a different tip would silently run old code, so
      // fail with an actionable error instead.
      if (pin && branchExists) {
        const tipRes = git.revParseRef(projectDir, `refs/heads/${info.branch}`)
        const tip = tipRes.ok ? tipRes.stdout.trim() : ''
        const pinnedRes = git.revParseRef(projectDir, pin.startRef)
        const pinned = pinnedRes.ok ? pinnedRes.stdout.trim() : pin.startRef
        if (tip !== pinned) {
          throw new Error(
            `forge workspace adapter: branch ${info.branch} already exists at ${tip ? tip.substring(0, 7) : 'unknown'} ` +
            `but this launch pinned ${pinned.substring(0, 7)}; delete the stale branch or use a different loop name`,
          )
        }
      }

      // Only pass startPoint when creating a new branch; existing branches always win.
      const startPoint = pin && !branchExists ? pin.startRef : undefined

      // Prune dead worktree records first so `git worktree add` can re-use an orphaned branch.
      git.worktreePrune(projectDir)

      let res = git.worktreeAdd(projectDir, info.directory, info.branch, !branchExists, startPoint)
      let reusedOrphan = false
      if (!res.ok) {
        const stderr = res.stderr.trim() || 'unknown error'
        const isAlreadyExists = /already exists/i.test(stderr) || /is already (checked out|registered)/i.test(stderr)
        if (isAlreadyExists && existsSync(info.directory)) {
          const existingBranch = git.currentBranch(info.directory)
          if (existingBranch === info.branch) {
            logger.log(`forge-adapter: reusing existing worktree ${info.directory} on branch ${info.branch}`)
            reusedOrphan = true
          } else {
            logger.log(`forge-adapter: worktree directory ${info.directory} already exists; cleaning up orphan and retrying`)
            const cleanup = await cleanupLoopWorktree({
              worktreeDir: info.directory,
              logPrefix: 'forge-adapter:create:orphan-cleanup',
              logger,
              git,
            })
            if (!cleanup.removed) {
              logger.error(`forge-adapter: orphan cleanup failed for ${info.directory}: ${cleanup.error ?? 'unknown error'}`)
              throw new Error(`git worktree add failed: ${stderr}`)
            }
            res = git.worktreeAdd(projectDir, info.directory, info.branch, !branchExists, startPoint)
            if (!res.ok) {
              const retryStderr = res.stderr.trim() || 'unknown error'
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

      // Idempotently add .forge/ (overflow/scratch) and any forge-written
      // opencode config to git exclude so they never enter loop commits.
      const excludePatterns = ['.forge/']
      const sandboxProvisioned = Boolean(sandboxManager) && !isLoopSandboxOptedOut(info)
      const cfgResult = writeWorktreeOpencodeConfig({
        directory: info.directory,
        config: worktreeOpencodeConfig,
        sandboxContainerName: sandboxProvisioned ? sandboxContainerName(info.name) : undefined,
        logger,
      })
      if (cfgResult.written) {
        excludePatterns.push(WORKTREE_OPENCODE_CONFIG_FILENAME)
      }
      addToGitExclude(info.directory, excludePatterns)

      if (sandboxManager && isLoopSandboxOptedOut(info)) {
        logger.log(`forge-adapter: skipping sandbox provisioning for ${info.name} (loop opted out via sandboxEnabled=false)`)
      } else if (sandboxManager) {
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
            const cleanup = git.worktreeRemove(projectDir, info.directory)
            if (!cleanup.ok) {
              logger.error(`forge-adapter: failed to remove worktree after sandbox failure: ${cleanup.stderr.trim() || 'unknown error'}`)
            }
          }
          git.worktreePrune(projectDir)
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

      // Remote-launched loops: drop the sync ref from the shared git remote.
      stepDeleteSyncRef(info, loopName, ctx)

      // Branches are never deleted — `forge/*` scratch branches stay in place for potential restart.
    },
    target(info) {
      return { type: 'local', directory: info.directory! }
    },
  }
}
