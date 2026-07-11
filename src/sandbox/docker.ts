import { spawn, type ChildProcess } from 'child_process'
import type { Logger, SandboxResources } from '../types'

export interface DockerExecOpts {
  timeout?: number
  cwd?: string
  abort?: AbortSignal
  stdin?: string
}

export interface DockerExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface BuildImageOpts {
  timeout?: number
}

export interface CreateContainerOpts {
  extraMounts?: string[]
  resources?: SandboxResources
  addHosts?: string[]
  envFile?: string
  user?: string
  /**
   * Enable Docker-in-Docker for this container. Adds `--privileged --init`, sets the
   * `FORGE_DIND=1` env var (which makes the image entrypoint boot a nested dockerd), and
   * backs the nested daemon's `/var/lib/docker` with an anonymous volume so overlay2 works.
   * `--init` installs a zombie-reaping init as PID 1, which matters when loops spawn many
   * short-lived test containers.
   */
  dockerInDocker?: boolean
  /**
   * Host UID:GID for the in-container exec user. When Docker-in-Docker is enabled, the GID is
   * passed to the entrypoint (`FORGE_HOST_GID`) so the nested dockerd owns its socket with that
   * group from creation, letting the non-root exec user reach the daemon without a perms race.
   */
  hostUser?: { uid: string; gid: string }
}

/** Container path for the nested Docker daemon's storage, backed by an anonymous volume. */
const DIND_STORAGE_PATH = '/var/lib/docker'

/**
 * Builds `docker exec` argument vectors. Single source of truth for both the standard and
 * stdin-piped exec paths so the optional host-user mapping (`--user`) is applied consistently.
 */
export function buildExecArgs(
  name: string,
  command: string,
  opts: { execUser?: string; interactive?: boolean } = {},
): string[] {
  const args = ['exec']
  if (opts.interactive) args.push('-i')
  if (opts.execUser) args.push('--user', opts.execUser)
  args.push(name, 'sh', '-c', command)
  return args
}

export function buildCreateContainerArgs(name: string, projectDir: string, image: string, opts: CreateContainerOpts = {}): string[] {
  const args: string[] = [
    'run',
    '-d',
    '--name',
    name,
    '-v',
    `${projectDir}:/workspace`,
  ]

  if (opts.dockerInDocker) {
    // Privileged + init lets a nested dockerd run with proper cgroup/iptables access and
    // a zombie-reaping PID 1. The anonymous volume keeps the daemon's overlay2 store off
    // the container's own overlay filesystem (overlay-on-overlay is unsupported).
    args.push('--privileged', '--init')
    args.push('-e', 'FORGE_DIND=1')
    if (opts.hostUser) {
      // Lets the entrypoint start dockerd with --group <host gid> so the host-UID exec user
      // can reach the daemon socket. UID is passed for completeness/diagnostics.
      args.push('-e', `FORGE_HOST_UID=${opts.hostUser.uid}`)
      args.push('-e', `FORGE_HOST_GID=${opts.hostUser.gid}`)
    }
    args.push('-v', DIND_STORAGE_PATH)
  }

  if (opts.resources?.memory) args.push('--memory', opts.resources.memory)
  if (opts.resources?.memorySwap) args.push('--memory-swap', opts.resources.memorySwap)
  if (opts.resources?.cpus) args.push('--cpus', opts.resources.cpus)
  if (opts.resources?.shmSize) args.push('--shm-size', opts.resources.shmSize)

  if (opts.addHosts) {
    for (const host of opts.addHosts) {
      args.push('--add-host', host)
    }
  }

  if (opts.envFile) {
    args.push('--env-file', opts.envFile)
  }

  if (opts.user) {
    args.push('--user', opts.user)
  }

  if (opts.extraMounts) {
    for (const mount of opts.extraMounts) {
      args.push('-v', mount)
    }
  }

  args.push('-w', '/workspace', image, 'sleep', 'infinity')

  return args
}

export interface DockerService {
  checkDocker(): Promise<boolean>
  imageExists(image: string): Promise<boolean>
  buildImage(contextDir: string, tag: string, opts?: BuildImageOpts): Promise<void>
  createContainer(name: string, projectDir: string, image: string, opts?: CreateContainerOpts): Promise<void>
  removeContainer(name: string): Promise<void>
  exec(name: string, command: string, opts?: DockerExecOpts): Promise<DockerExecResult>
  execPipe(name: string, command: string, stdin: string, opts?: { timeout?: number; abort?: AbortSignal }): Promise<DockerExecResult>
  isRunning(name: string): Promise<boolean>
  containerName(worktreeName: string): string
  listContainersByPrefix(prefix: string): Promise<string[]>
}

export interface DockerServiceOpts {
  /**
   * UID:GID applied to in-container commands via `docker exec --user`. The container itself
   * runs as root (required by the nested Docker daemon), but the agent's shell commands run as
   * this user so files written to the bind-mounted worktree are owned by the host user rather
   * than root. Typically the host process UID:GID. Undefined runs commands as the container's
   * default user (root).
   */
  execUser?: string
}

/** Deterministic sandbox container name for a loop worktree. */
export function sandboxContainerName(worktreeName: string): string {
  return `forge-${worktreeName}`
}

export function createDockerService(logger: Logger, opts: DockerServiceOpts = {}): DockerService {
  const DEFAULT_TIMEOUT = 120000
  const BUILD_TIMEOUT = 600000
  const execUser = opts.execUser

  const containerName = sandboxContainerName

  async function checkDocker(): Promise<boolean> {
    try {
      const result = await execPromise('docker', ['info'], { timeout: 5000 })
      return result.exitCode === 0
    } catch {
      return false
    }
  }

  async function imageExists(image: string): Promise<boolean> {
    try {
      const result = await execPromise('docker', ['image', 'inspect', image], { timeout: 5000 })
      return result.exitCode === 0
    } catch {
      return false
    }
  }

  async function buildImage(contextDir: string, tag: string, opts?: BuildImageOpts): Promise<void> {
    const timeout = opts?.timeout ?? BUILD_TIMEOUT
    const result = await execPromise('docker', ['build', '-t', tag, contextDir], { timeout })

    if (result.exitCode === 0) return

    if (result.exitCode === 124) {
      throw new Error(`Docker build timed out after ${Math.round(timeout / 1000)} seconds.`)
    }

    const output = result.stderr || result.stdout
    throw new Error(`Docker build failed: ${output}`)
  }

  async function createContainer(name: string, projectDir: string, image: string, opts?: CreateContainerOpts): Promise<void> {
    // Derive hostUser from the configured exec user so the nested daemon's socket group matches
    // the UID that runs in-container commands. Single source of truth: the service's execUser.
    const effectiveOpts: CreateContainerOpts = { ...opts }
    if (execUser && !effectiveOpts.hostUser) {
      const [uid, gid] = execUser.split(':')
      if (uid && gid) effectiveOpts.hostUser = { uid, gid }
    }
    const args = buildCreateContainerArgs(name, projectDir, image, effectiveOpts)

    const result = await execPromise('docker', args, { timeout: 30000 })
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create container: ${result.stderr}`)
    }
  }

  async function removeContainer(name: string): Promise<void> {
    // `-v` removes anonymous volumes attached to the container (e.g. the Docker-in-Docker
    // /var/lib/docker store). Bind mounts and named volumes are unaffected, so this is safe
    // for non-DinD containers, which have no anonymous volumes.
    const result = await execPromise('docker', ['rm', '-fv', name], { timeout: 30000 })
    if (result.exitCode !== 0 && !result.stderr.includes('No such container')) {
      throw new Error(`Failed to remove container: ${result.stderr}`)
    }
  }

  async function exec(
    name: string,
    command: string,
    opts?: DockerExecOpts,
  ): Promise<DockerExecResult> {
    const timeout = opts?.timeout ?? DEFAULT_TIMEOUT
    const cwd = opts?.cwd

    let fullCommand: string
    if (cwd) {
      const safeCwd = cwd.replace(/'/g, "'\\''")
      fullCommand = `cd '${safeCwd}' && ${command}`
    } else {
      fullCommand = command
    }

    const args = buildExecArgs(name, fullCommand, { execUser })

    return execPromise('docker', args, { timeout, streaming: true, abort: opts?.abort })
  }

  async function execPipe(
    name: string,
    command: string,
    stdin: string,
    opts?: { timeout?: number; abort?: AbortSignal },
  ): Promise<DockerExecResult> {
    const args = buildExecArgs(name, command, { execUser, interactive: true })

    return execPromise('docker', args, {
      timeout: opts?.timeout ?? DEFAULT_TIMEOUT,
      stdin,
      abort: opts?.abort,
    })
  }

  async function isRunning(name: string): Promise<boolean> {
    try {
      const result = await execPromise('docker', ['inspect', '--format={{.State.Running}}', name], {
        timeout: 5000,
      })
      return result.stdout.trim() === 'true'
    } catch {
      return false
    }
  }

  async function listContainersByPrefix(prefix: string): Promise<string[]> {
    try {
      const result = await execPromise('docker', ['ps', '-a', '--filter', `name=${prefix}`, '--format', '{{.Names}}'], { timeout: 5000 })
      if (result.exitCode !== 0) return []
      return result.stdout.trim().split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

  function execPromise(
    command: string,
    args: string[],
    options?: { timeout?: number; streaming?: boolean; abort?: AbortSignal; stdin?: string },
  ): Promise<DockerExecResult> {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT
    const cmdPreview = args.slice(-1)[0]?.slice(0, 80) ?? ''

    let hardDeadlineId: ReturnType<typeof setTimeout> | undefined

    const inner = new Promise<DockerExecResult>((resolve) => {
      const stdioConfig: 'pipe' | 'ignore' = options?.stdin ? 'pipe' : 'ignore'
      const child: ChildProcess = spawn(command, args, {
        stdio: [stdioConfig, 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false

      function settle(result: DockerExecResult): void {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        clearTimeout(hardDeadlineId)
        resolve(result)
      }

      const timeoutId = setTimeout(() => {
        timedOut = true
        logger.log(`[docker] timeout (${timeout}ms) for: ${cmdPreview}`)
        child.kill('SIGTERM')
        setTimeout(() => {
          if (!settled) {
            logger.log(`[docker] SIGKILL after SIGTERM for: ${cmdPreview}`)
            child.kill('SIGKILL')
          }
        }, 5000)
      }, timeout)

      if (options?.abort) {
        const onAbort = () => {
          logger.log(`[docker] abort signal for: ${cmdPreview}`)
          child.kill('SIGTERM')
          setTimeout(() => {
            if (!settled) child.kill('SIGKILL')
          }, 5000)
        }
        if (options.abort.aborted) {
          onAbort()
        } else {
          options.abort.addEventListener('abort', onAbort, { once: true })
        }
      }

      child.stdout!.on('data', (data: Buffer) => {
        stdout += data.toString()
      })

      child.stderr!.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      if (options?.stdin) {
        child.stdin!.write(options.stdin)
        child.stdin!.end()
      }

      child.on('close', (code: number | null) => {
        if (timedOut) {
          logger.log(`[docker] close after timeout, code=${code} for: ${cmdPreview}`)
        }
        settle({
          stdout,
          stderr,
          exitCode: timedOut ? 124 : (code ?? 1),
        })
      })

      child.on('error', (err: Error) => {
        logger.log(`[docker] spawn error: ${err.message} for: ${cmdPreview}`)
        settle({
          stdout,
          stderr: stderr + err.message,
          exitCode: 1,
        })
      })
    })

    const hardDeadline = timeout + 10_000
    const deadlinePromise = new Promise<DockerExecResult>((resolve) => {
      hardDeadlineId = setTimeout(() => {
        logger.log(`[docker] hard deadline (${hardDeadline}ms) hit for: ${cmdPreview}`)
        resolve({ stdout: '', stderr: `Command exceeded hard deadline of ${hardDeadline}ms`, exitCode: 124 })
      }, hardDeadline)
    })

    return Promise.race([inner, deadlinePromise])
  }

  return {
    checkDocker,
    imageExists,
    buildImage,
    createContainer,
    removeContainer,
    exec,
    execPipe,
    isRunning,
    containerName,
    listContainersByPrefix,
  }
}
