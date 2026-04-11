import type { DockerService } from './docker'
import type { Logger } from '../types'
import { resolve } from 'path'
import { spawnSync } from 'child_process'

export interface SandboxManagerConfig {
  image: string
}

export interface ActiveSandbox {
  containerName: string
  projectDir: string
  startedAt: string
}

export interface SandboxManager {
  docker: DockerService
  start(worktreeName: string, projectDir: string, startedAt?: string): Promise<{ containerName: string }>
  stop(worktreeName: string): Promise<void>
  getActive(worktreeName: string): ActiveSandbox | null
  isActive(worktreeName: string): boolean
  cleanupOrphans(preserveWorktrees?: string[]): Promise<number>
  restore(worktreeName: string, projectDir: string, startedAt: string): Promise<void>
}

export function createSandboxManager(
  docker: DockerService,
  config: SandboxManagerConfig,
  logger: Logger,
): SandboxManager {
  const activeSandboxes = new Map<string, ActiveSandbox>()

  function detectGitMount(projectDir: string): string[] {
    try {
      const result = spawnSync('git', ['rev-parse', '--git-common-dir'], {
        cwd: projectDir,
        encoding: 'utf-8',
      })
      if (result.status !== 0 || !result.stdout) return []
      
      const gitCommonDir = resolve(projectDir, result.stdout.trim())
      
      // If the git dir is already inside the project dir being mounted, no extra mount needed
      if (gitCommonDir.startsWith(projectDir + '/')) return []
      
      return [`${gitCommonDir}:${gitCommonDir}:ro`]
    } catch {
      logger.log(`[sandbox] could not detect git common dir for ${projectDir}, skipping extra mount`)
      return []
    }
  }

  async function start(worktreeName: string, projectDir: string, startedAt?: string): Promise<{ containerName: string }> {
    const dockerAvailable = await docker.checkDocker()
    if (!dockerAvailable) {
      throw new Error('Docker is not available. Please ensure Docker is running.')
    }

    const imageExists = await docker.imageExists(config.image)
    if (!imageExists) {
      throw new Error(
        `Docker image "${config.image}" not found. Build it first:\n` +
        `  docker build -t ${config.image} container/`
      )
    }

    const containerName = docker.containerName(worktreeName)

    const running = await docker.isRunning(containerName)
    if (running) {
      logger.log(`Sandbox container ${containerName} already running`)
      return { containerName }
    }

    const absoluteProjectDir = resolve(projectDir)
    const extraMounts = detectGitMount(absoluteProjectDir)
    if (extraMounts.length > 0) {
      logger.log(`Sandbox: mounting git common dir: ${extraMounts[0]}`)
    }
    logger.log(`Creating sandbox container ${containerName} for ${absoluteProjectDir}`)
    await docker.createContainer(containerName, absoluteProjectDir, config.image, extraMounts)

    const active: ActiveSandbox = {
      containerName,
      projectDir: absoluteProjectDir,
      startedAt: startedAt ?? new Date().toISOString(),
    }

    activeSandboxes.set(worktreeName, active)
    logger.log(`Sandbox container ${containerName} started`)

    return { containerName }
  }

  async function stop(worktreeName: string): Promise<void> {
    const active = activeSandboxes.get(worktreeName)
    const containerName = active?.containerName || docker.containerName(worktreeName)

    try {
      await docker.removeContainer(containerName)
      logger.log(`Sandbox container ${containerName} removed`)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.log(`Sandbox container ${containerName} removal: ${errMsg}`)
    } finally {
      activeSandboxes.delete(worktreeName)
    }
  }

  function getActive(worktreeName: string): ActiveSandbox | null {
    return activeSandboxes.get(worktreeName) || null
  }

  function isActive(worktreeName: string): boolean {
    return activeSandboxes.has(worktreeName)
  }

  async function cleanupOrphans(preserveWorktrees?: string[]): Promise<number> {
    const containers = await docker.listContainersByPrefix('oc-forge-sandbox-')
    let removed = 0

    const preserveSet = preserveWorktrees
      ? new Set(preserveWorktrees.map((wt) => docker.containerName(wt)))
      : new Set<string>()

    for (const name of containers) {
      if (preserveSet.has(name)) {
        continue
      }
      try {
        await docker.removeContainer(name)
        removed++
        logger.log(`Removed orphaned sandbox container: ${name}`)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        logger.error(`Failed to remove orphaned sandbox container ${name}: ${errMsg}`)
      }
    }

    if (!preserveWorktrees) {
      activeSandboxes.clear()
    } else {
      for (const key of activeSandboxes.keys()) {
        if (!preserveWorktrees.includes(key)) {
          activeSandboxes.delete(key)
        }
      }
    }

    return removed
  }

  async function restore(worktreeName: string, projectDir: string, startedAt: string): Promise<void> {
    const containerName = docker.containerName(worktreeName)
    const running = await docker.isRunning(containerName)
    if (running) {
      logger.log(`Sandbox container ${containerName} already running, repopulating map`)
      activeSandboxes.set(worktreeName, { containerName, projectDir: resolve(projectDir), startedAt })
    } else {
      logger.log(`Sandbox container ${containerName} not running, starting new container`)
      await start(worktreeName, projectDir, startedAt)
    }
  }

  return {
    docker,
    start,
    stop,
    getActive,
    isActive,
    cleanupOrphans,
    restore,
  }
}
