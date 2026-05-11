import type { DockerService } from './docker'
import type { Logger } from '../types'
import { resolve } from 'path'
import { join } from 'path'
import { existsSync } from 'fs'
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
  isLive(worktreeName: string): Promise<boolean>
  isLiveByName(worktreeName: string): Promise<boolean>
  cleanupOrphans(preserveWorktrees?: string[]): Promise<number>
  restore(worktreeName: string, projectDir: string, startedAt: string): Promise<void>
  provisionDependencies(worktreeName: string, projectDir: string): Promise<void>
}

export function createSandboxManager(
  docker: DockerService,
  config: SandboxManagerConfig,
  logger: Logger,
): SandboxManager {
  const activeSandboxes = new Map<string, ActiveSandbox>()

  function detectGitMount(projectDir: string): string[] {
    try {
      const gitDirResult = spawnSync('git', ['rev-parse', '--git-dir'], {
        cwd: projectDir,
        encoding: 'utf-8',
      })
      const commonDirResult = spawnSync('git', ['rev-parse', '--git-common-dir'], {
        cwd: projectDir,
        encoding: 'utf-8',
      })
      if (gitDirResult.status !== 0 || commonDirResult.status !== 0 || !gitDirResult.stdout || !commonDirResult.stdout) return []

      const mounts = new Set<string>()
      const gitDir = resolve(projectDir, gitDirResult.stdout.trim())
      const gitCommonDir = resolve(projectDir, commonDirResult.stdout.trim())

      if (!gitDir.startsWith(projectDir + '/')) {
        mounts.add(`${gitDir}:${gitDir}`)
      }

      if (!gitCommonDir.startsWith(projectDir + '/')) {
        mounts.add(`${gitCommonDir}:${gitCommonDir}`)
      }

      return [...mounts]
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

    const absoluteProjectDir = resolve(projectDir)
    const running = await docker.isRunning(containerName)
    if (running) {
      logger.log(`Sandbox container ${containerName} already running`)
      activeSandboxes.set(worktreeName, {
        containerName,
        projectDir: absoluteProjectDir,
        startedAt: startedAt ?? new Date().toISOString(),
      })
      return { containerName }
    }
    const extraMounts = detectGitMount(absoluteProjectDir)
    if (extraMounts.length > 0) {
      logger.log(`Sandbox: mounting git metadata: ${extraMounts.join(', ')}`)
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

  async function isLive(worktreeName: string): Promise<boolean> {
    const active = activeSandboxes.get(worktreeName)
    if (!active) {
      return false
    }
    
    const containerName = active.containerName
    const running = await docker.isRunning(containerName)
    
    if (!running) {
      // Container is not running in Docker - remove stale map entry
      logger.log(`Sandbox: container ${containerName} not found in Docker, removing stale map entry for ${worktreeName}`)
      activeSandboxes.delete(worktreeName)
      return false
    }
    
    return true
  }

  async function isLiveByName(worktreeName: string): Promise<boolean> {
    const containerName = docker.containerName(worktreeName)
    return docker.isRunning(containerName)
  }

  async function cleanupOrphans(preserveWorktrees?: string[]): Promise<number> {
    const containers = await docker.listContainersByPrefix('forge-')
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

  async function provisionDependencies(worktreeName: string, projectDir: string): Promise<void> {
    const lockfilePath = join(resolve(projectDir), 'pnpm-lock.yaml')
    if (!existsSync(lockfilePath)) {
      logger.log(`[sandbox] no pnpm-lock.yaml at ${lockfilePath}; skipping dependency provisioning`)
      return
    }
    const containerName = docker.containerName(worktreeName)
    logger.log(`[sandbox] provisioning dependencies for ${containerName}: pnpm install --prefer-offline --frozen-lockfile`)
    const result = await docker.exec(containerName, 'pnpm install --prefer-offline --frozen-lockfile', {
      cwd: '/workspace',
      timeout: 10 * 60 * 1000, // 10 minutes
    })
    if (result.exitCode !== 0) {
      const tail = result.stderr.split('\n').slice(-40).join('\n')
      throw new Error(`pnpm install failed (exit ${result.exitCode}) for ${containerName}:\n${tail}`)
    }
    logger.log(`[sandbox] provisioning complete for ${containerName}`)
  }

  return {
    docker,
    start,
    stop,
    getActive,
    isActive,
    isLive,
    isLiveByName,
    cleanupOrphans,
    restore,
    provisionDependencies,
  }
}
