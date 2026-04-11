import { spawn, type ChildProcess } from 'child_process'
import type { Logger } from '../types'

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

export interface DockerService {
  checkDocker(): Promise<boolean>
  imageExists(image: string): Promise<boolean>
  buildImage(dockerfilePath: string, tag: string): Promise<void>
  createContainer(name: string, projectDir: string, image: string, extraMounts?: string[]): Promise<void>
  removeContainer(name: string): Promise<void>
  exec(name: string, command: string, opts?: DockerExecOpts): Promise<DockerExecResult>
  execPipe(name: string, command: string, stdin: string, opts?: { timeout?: number; abort?: AbortSignal }): Promise<DockerExecResult>
  isRunning(name: string): Promise<boolean>
  containerName(worktreeName: string): string
  listContainersByPrefix(prefix: string): Promise<string[]>
}

export function createDockerService(logger: Logger): DockerService {
  const DEFAULT_TIMEOUT = 120000

  function containerName(worktreeName: string): string {
    return `oc-forge-sandbox-${worktreeName}`
  }

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

  async function buildImage(dockerfilePath: string, tag: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('docker', ['build', '-t', tag, dockerfilePath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const stderr: string[] = []
      child.stderr.on('data', (data) => {
        stderr.push(data.toString())
      })

      child.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`Docker build failed: ${stderr.join('')}`))
        }
      })

      child.on('error', reject)
    })
  }

  async function createContainer(name: string, projectDir: string, image: string, extraMounts?: string[]): Promise<void> {
    const args = [
      'run',
      '-d',
      '--name',
      name,
      '-v',
      `${projectDir}:/workspace`,
    ]

    if (extraMounts) {
      for (const mount of extraMounts) {
        args.push('-v', mount)
      }
    }

    args.push('-w', '/workspace', image, 'sleep', 'infinity')

    const result = await execPromise('docker', args, { timeout: 30000 })
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create container: ${result.stderr}`)
    }
  }

  async function removeContainer(name: string): Promise<void> {
    const result = await execPromise('docker', ['rm', '-f', name], { timeout: 30000 })
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

    const args = ['exec', name, 'sh', '-c', fullCommand]

    return execPromise('docker', args, { timeout, streaming: true, abort: opts?.abort })
  }

  async function execPipe(
    name: string,
    command: string,
    stdin: string,
    opts?: { timeout?: number; abort?: AbortSignal },
  ): Promise<DockerExecResult> {
    return execPromise('docker', ['exec', '-i', name, 'sh', '-c', command], {
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
