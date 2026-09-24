import { mkdir } from 'fs/promises'
import { existsSync, readFileSync, appendFileSync } from 'fs'
import type { Logger } from '../types'
import type { SandboxManager } from '../sandbox/manager'
import { forgeBranchName, forgeWorktreeDir, forgeWorktreeSlug, forgeWorktreesRoot } from './forge-naming'
import { cleanupLoopWorktree } from '../utils/worktree-cleanup'
import { defaultGitService, type GitService } from '../utils/git-service'
import { writeWorktreeOpencodeConfig, WORKTREE_OPENCODE_CONFIG_FILENAME } from './worktree-opencode-config'
import { commitWorktreeChanges } from './worktree-commit'
import { sandboxContainerName } from '../sandbox/msb'

export interface ForgeWorkspaceInfo {
  id: string
  type: string
  name: string
  branch: string | null
  directory: string | null
  extra: unknown | null
  projectID: string
}

export interface ForgeWorkspaceAdapter {
  configure(info: ForgeWorkspaceInfo): ForgeWorkspaceInfo
  create(info: ForgeWorkspaceInfo): Promise<void>
  remove(info: ForgeWorkspaceInfo): Promise<void>
}

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

export function createForgeWorkspaceAdapter(deps: ForgeAdapterDeps): ForgeWorkspaceAdapter {
  const { dataDir, logger, sandboxManager, getTeardownContext, gitService: gitServiceOpt, worktreeOpencodeConfig } = deps
  const git = gitServiceOpt ?? defaultGitService

  function deriveLoopName(info: ForgeWorkspaceInfo): string {
    const extra = (info.extra ?? {}) as { loopName?: unknown }
    const raw = typeof extra.loopName === 'string' ? extra.loopName : ''
    if (!raw) throw new Error('forge workspace adapter: extra.loopName is required')
    return forgeWorktreeSlug(raw)
  }

  function deriveProjectDirectory(info: ForgeWorkspaceInfo): string {
    const extra = (info.extra ?? {}) as { projectDirectory?: unknown }
    const dir = typeof extra.projectDirectory === 'string' ? extra.projectDirectory : ''
    if (!dir) throw new Error('forge workspace adapter: extra.projectDirectory is required')
    return dir
  }

  /**
   * Whether this workspace's loop explicitly opted out of the sandbox
   * (`extra.forgeLoop.sandboxEnabled === false`). Provisioning must honor the
   * per-loop flag even when the config has the sandbox enabled.
   */
  function isLoopSandboxOptedOut(info: ForgeWorkspaceInfo): boolean {
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

  function resolveLoopName(info: ForgeWorkspaceInfo): string {
    try {
      return deriveLoopName(info)
    } catch {
      return info.name || 'unknown'
    }
  }

  async function stepCommitChanges(loopName: string, directory: string, branchLabel: string, ctx: TeardownContext): Promise<void> {
    if (!ctx.doCommit || !existsSync(directory)) return

    try {
      const iterLabel = ctx.iteration === 1 ? 'iteration' : 'iterations'
      const message = `loop: ${loopName} ${ctx.reasonLabel} after ${ctx.iteration} ${iterLabel}`
      const outcome = commitWorktreeChanges(git, logger, directory, message)

      if (outcome === 'committed') {
        logger.log(`forge-adapter: committed pending changes on ${branchLabel}`)
      } else if (outcome === 'no-changes') {
        logger.log(`forge-adapter: no pending changes to commit on ${branchLabel}`)
      } else {
        logger.log(`forge-adapter: commit failed on ${branchLabel}`)
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
   * Stamps the attach timestamps with the creation time. `configure` runs
   * exactly once at creation, so it is the single normalization point for the
   * attach/pending-start grace windows evaluated in classify-stale.ts.
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

  return {
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
      await mkdir(forgeWorktreesRoot(dataDir), { recursive: true })

      if (!git.isInsideWorkTree(projectDir)) {
        throw new Error(`forge workspace adapter: projectDirectory ${projectDir} is not a git work tree`)
      }

      // Detect orphan state from a prior failed run: branch may exist without a live worktree.
      const branchExists = git.branchExists(projectDir, info.branch)

      // Prune dead worktree records first so `git worktree add` can re-use an orphaned branch.
      git.worktreePrune(projectDir)

      let res = git.worktreeAdd(projectDir, info.directory, info.branch, !branchExists)
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
            res = git.worktreeAdd(projectDir, info.directory, info.branch, !branchExists)
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

      // Branches are never deleted — `forge/*` scratch branches stay in place for potential restart.
    },
  }
}
