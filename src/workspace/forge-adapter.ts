import { mkdir } from 'fs/promises'
import { z } from 'zod'
import { existsSync, readFileSync, appendFileSync, realpathSync } from 'fs'
import type { Logger, LoopSandboxSettings } from '../types'
import type { SandboxManager } from '../sandbox/manager'
import { LOOP_SANDBOX_EXTRA_KEY, readLoopSandboxSettings } from '../sandbox/loop-settings'
import type { WorkspaceExtra } from '../client/port'
import { getForgeWorkspaceBaseRef, getForgeWorkspaceBranch, getForgeWorkspaceForgeLoop, getForgeWorkspaceLoopName, getForgeWorkspaceProjectDirectory } from './forge-worktree'
import { describeBranchInUse, describeBranchReuseConflict } from './loop-branch'
import { forgeWorktreeDir, forgeWorktreeSlug, forgeWorktreesRoot, resolveLoopBranchName } from './forge-naming'
import { cleanupLoopWorktree } from '../utils/worktree-cleanup'
import { defaultGitService, type GitService } from '../utils/git-service'
import { writeWorktreeOpencodeConfig, WORKTREE_OPENCODE_CONFIG_FILENAME, type WorktreeOpencodeConfig } from './worktree-opencode-config'
import { commitWorktreeChanges } from './worktree-commit'
import { sandboxContainerName } from '../sandbox/msb'
import { CODE_GRAPH_LINK_NAME } from '../constants/loop'

const jsonObjectSchema = z.record(z.string(), z.json())
type JsonBlock = z.infer<typeof jsonObjectSchema>

function isJsonBlock(value: WorkspaceExtra['forgeLoop']): value is JsonBlock {
  return jsonObjectSchema.safeParse(value).success
}

export interface ForgeWorkspaceInfo {
  id: string
  type: string
  name: string
  branch: string | null
  directory: string | null
  extra: WorkspaceExtra | null
  projectID: string
}

export interface ForgeWorkspaceAdapter {
  configure(info: ForgeWorkspaceInfo): ForgeWorkspaceInfo
  create(info: ForgeWorkspaceInfo): Promise<void>
  remove(info: ForgeWorkspaceInfo): Promise<void>
}

export interface TeardownContext {
  doCommit: boolean
  doRemoveWorktree: boolean
}

export type TeardownContextProvider = (loopName: string) => TeardownContext | undefined

export interface ForgeAdapterDeps {
  dataDir: string
  logger: Logger
  sandboxManager?: Pick<SandboxManager, 'start' | 'stop'> | null
  getTeardownContext?: TeardownContextProvider
  gitService?: GitService
  worktreeOpencodeConfig?: WorktreeOpencodeConfig
  codeGraphEnabled?: boolean
}

const DEFAULT_TEARDOWN_CONTEXT: TeardownContext = {
  doCommit: true,
  doRemoveWorktree: true,
}

const BRANCH_IN_USE_PATTERNS = [
  /is already checked out at ['"]([^'"]+)['"]/i,
  /is already used by worktree at ['"]([^'"]+)['"]/i,
]

function parseBranchInUsePath(stderr: string): string | null {
  for (const pattern of BRANCH_IN_USE_PATTERNS) {
    const match = pattern.exec(stderr)
    if (match) return match[1]
  }
  return null
}

function isSameDirectory(a: string, b: string): boolean {
  if (a === b) return true
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

function worktreeAddFailure(branch: string, directory: string, stderr: string): Error {
  const holder = parseBranchInUsePath(stderr)
  if (holder !== null && !isSameDirectory(holder, directory)) {
    return new Error(`forge workspace adapter: ${describeBranchInUse(branch, holder)}`)
  }
  return new Error(`git worktree add failed: ${stderr}`)
}

export function createForgeWorkspaceAdapter(deps: ForgeAdapterDeps): ForgeWorkspaceAdapter {
  const { dataDir, logger, sandboxManager, getTeardownContext, gitService: gitServiceOpt, worktreeOpencodeConfig, codeGraphEnabled } = deps
  const git = gitServiceOpt ?? defaultGitService

  function deriveLoopName(info: ForgeWorkspaceInfo): string {
    const raw = getForgeWorkspaceLoopName(info)
    if (!raw) throw new Error('forge workspace adapter: extra.loopName is required')
    return forgeWorktreeSlug(raw)
  }

  function deriveProjectDirectory(info: ForgeWorkspaceInfo): string {
    const dir = getForgeWorkspaceProjectDirectory(info)
    if (!dir) throw new Error('forge workspace adapter: extra.projectDirectory is required')
    return dir
  }

  function readLoopSandbox(info: ForgeWorkspaceInfo): LoopSandboxSettings | undefined {
    return readLoopSandboxSettings(info.extra?.[LOOP_SANDBOX_EXTRA_KEY])
  }

  function isLoopSandboxOptedOut(info: ForgeWorkspaceInfo): boolean {
    if (readLoopSandbox(info)?.enabled === false) return true
    return getForgeWorkspaceForgeLoop(info)?.sandboxEnabled === false
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

  async function stepCommitChanges(directory: string, branchLabel: string, ctx: TeardownContext): Promise<void> {
    if (!ctx.doCommit || !existsSync(directory)) return

    try {
      const message = 'Apply remaining changes'
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

  function restampAttachTimestamps(extra: WorkspaceExtra | null): WorkspaceExtra | null {
    if (extra === null) return null
    const now = Date.now()
    const result: WorkspaceExtra = { ...extra, workspaceCreatedAt: now }
    const forgeLoop = extra.forgeLoop
    if (isJsonBlock(forgeLoop) && getForgeWorkspaceForgeLoop({ extra })?.pendingAttachStartedAt !== undefined) {
      result.forgeLoop = { ...forgeLoop, pendingAttachStartedAt: now }
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
        branch: resolveLoopBranchName(loopName, getForgeWorkspaceBranch(info)),
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

      const branchExists = git.branchExists(projectDir, info.branch)
      const baseRef = getForgeWorkspaceBaseRef(info)

      git.worktreePrune(projectDir)

      if (baseRef) {
        if (branchExists) {
          const conflict = describeBranchReuseConflict(git, projectDir, info.branch, baseRef)
          if (conflict !== null) {
            throw new Error(`forge workspace adapter: ${conflict}`)
          }
          const forceRes = git.branchForceUpdate(projectDir, info.branch, baseRef)
          if (!forceRes.ok) {
            const stderr = forceRes.stderr.trim() || 'unknown error'
            logger.error(`forge-adapter: git branch -f failed: ${stderr}`)
            throw new Error(`git branch -f failed: ${stderr}`)
          }
        }
        const res = branchExists
          ? git.worktreeAdd(projectDir, info.directory, info.branch, false)
          : git.worktreeAdd(projectDir, info.directory, info.branch, true, baseRef)
        if (!res.ok) {
          const stderr = res.stderr.trim() || 'unknown error'
          logger.error(`forge-adapter: git worktree add failed: ${stderr}`)
          if (existsSync(info.directory)) {
            const cleanup = await cleanupLoopWorktree({
              worktreeDir: info.directory,
              logPrefix: 'forge-adapter:create:based-cleanup',
              logger,
              git,
            })
            if (!cleanup.removed) {
              logger.error(`forge-adapter: cleanup after failed based create failed for ${info.directory}: ${cleanup.error ?? 'unknown error'}`)
            }
          }
          git.worktreePrune(projectDir)
          throw worktreeAddFailure(info.branch, info.directory, stderr)
        }
        logger.log(`forge-adapter: created worktree ${info.directory} on branch ${info.branch} (based on ${baseRef})${branchExists ? ` (fast-forwarded existing branch to ${baseRef})` : ''}`)
      } else {
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
                throw worktreeAddFailure(info.branch, info.directory, retryStderr)
              }
              reusedOrphan = true
            }
          } else {
            logger.error(`forge-adapter: git worktree add failed: ${stderr}`)
            throw worktreeAddFailure(info.branch, info.directory, stderr)
          }
        }
        logger.log(`forge-adapter: created worktree ${info.directory} on branch ${info.branch}${branchExists ? ' (reused existing branch)' : ''}${reusedOrphan ? ' (after orphan cleanup)' : ''}`)
      }

      const excludePatterns = ['.forge/']
      const sandboxProvisioned = Boolean(sandboxManager) && !isLoopSandboxOptedOut(info)
      if (sandboxProvisioned && codeGraphEnabled !== false) {
        excludePatterns.push(CODE_GRAPH_LINK_NAME)
      }
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
          const sandbox = await sandboxManager.start(info.name, info.directory, startedAt, readLoopSandbox(info))
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

      await stepCommitChanges(info.directory, info.branch ?? '<branch>', ctx)

      await stepStopSandbox(sandboxManager, info.name)

      await stepRemoveWorktree(info.directory, ctx)

    },
  }
}
