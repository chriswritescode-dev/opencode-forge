import { spawn, type ChildProcess } from 'child_process'
import type { Logger } from '../types'

export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface RunCommandOpts {
  timeout?: number
  abort?: AbortSignal
  stdin?: string
  logger: Logger
  logLabel?: string
}

const DEFAULT_TIMEOUT = 120000

export function runCommand(command: string, args: string[], opts: RunCommandOpts): Promise<CommandResult> {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT
  const logLabel = opts.logLabel ?? 'sandbox'
  const cmdPreview = args.slice(-1)[0]?.slice(0, 80) ?? ''

  let hardDeadlineId: ReturnType<typeof setTimeout> | undefined

  const inner = new Promise<CommandResult>((resolve) => {
    const stdioConfig: 'pipe' | 'ignore' = opts.stdin ? 'pipe' : 'ignore'
    const child: ChildProcess = spawn(command, args, {
      stdio: [stdioConfig, 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    function settle(result: CommandResult): void {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      clearTimeout(hardDeadlineId)
      resolve(result)
    }

    const timeoutId = setTimeout(() => {
      timedOut = true
      opts.logger.log(`[${logLabel}] timeout (${timeout}ms) for: ${cmdPreview}`)
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!settled) {
          opts.logger.log(`[${logLabel}] SIGKILL after SIGTERM for: ${cmdPreview}`)
          child.kill('SIGKILL')
        }
      }, 5000)
    }, timeout)

    if (opts.abort) {
      const onAbort = () => {
        opts.logger.log(`[${logLabel}] abort signal for: ${cmdPreview}`)
        child.kill('SIGTERM')
        setTimeout(() => {
          if (!settled) child.kill('SIGKILL')
        }, 5000)
      }
      if (opts.abort.aborted) {
        onAbort()
      } else {
        opts.abort.addEventListener('abort', onAbort, { once: true })
      }
    }

    child.stdout!.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    child.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    if (opts.stdin) {
      child.stdin!.write(opts.stdin)
      child.stdin!.end()
    }

    child.on('close', (code: number | null) => {
      if (timedOut) {
        opts.logger.log(`[${logLabel}] close after timeout, code=${code} for: ${cmdPreview}`)
      }
      settle({
        stdout,
        stderr,
        exitCode: timedOut ? 124 : (code ?? 1),
      })
    })

    child.on('error', (err: Error) => {
      opts.logger.log(`[${logLabel}] spawn error: ${err.message} for: ${cmdPreview}`)
      settle({
        stdout,
        stderr: stderr + err.message,
        exitCode: 1,
      })
    })
  })

  const hardDeadline = timeout + 10_000
  const deadlinePromise = new Promise<CommandResult>((resolve) => {
    hardDeadlineId = setTimeout(() => {
      opts.logger.log(`[${logLabel}] hard deadline (${hardDeadline}ms) hit for: ${cmdPreview}`)
      resolve({ stdout: '', stderr: `Command exceeded hard deadline of ${hardDeadline}ms`, exitCode: 124 })
    }, hardDeadline)
  })

  return Promise.race([inner, deadlinePromise])
}
