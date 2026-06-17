import { join } from 'path'
import { toContainerPath, rewriteOutput } from '../../sandbox/path'
import type { SandboxContext } from '../../sandbox/context'
import { tail, writeOverflow } from './truncate'
import type { Limits } from './truncate'
import type { Logger } from '../../types'

const BASH_DEFAULT_TIMEOUT_MS = 120_000

export interface BashArgs {
  command: string
  timeout?: number
  workdir?: string
  description: string
}

export interface ExecDeps {
  logger: Logger
}

export async function runInSandbox(
  args: BashArgs,
  sandbox: SandboxContext,
  deps: ExecDeps,
  ctx: { messageID: string },
  limits: Limits,
): Promise<string> {
  const { docker, containerName, mounts } = sandbox
  const cwd = args.workdir ? toContainerPath(args.workdir, mounts) : undefined
  const callID = ctx.messageID + '-' + Date.now()
  deps.logger.log(`[bash-tool] sandbox exec container=${containerName} cmd=${args.command.slice(0, 100)}`)

  const result = await docker.exec(containerName, args.command, {
    timeout: args.timeout,
    cwd,
  })

  const raw = rewriteOutput(result.stdout, mounts) +
    (result.stderr && result.exitCode !== 0 ? rewriteOutput(result.stderr, mounts) : '')
  const end = tail(raw, limits.maxLines, limits.maxBytes)
  let output = end.text || '(no output)'
  if (end.cut) {
    const overflowDir = join(sandbox.hostDir, '.forge', 'tmp')
    const overflowPath = writeOverflow(overflowDir, callID, raw)
    output = `...output truncated...\n\nFull output saved to: ${overflowPath}\n\n` + output
  }
  if (result.exitCode === 124) {
    const timeoutMs = args.timeout ?? BASH_DEFAULT_TIMEOUT_MS
    output += `\n\n<bash_metadata>\nbash tool terminated command after exceeding timeout ${timeoutMs} ms\n</bash_metadata>`
  } else if (result.exitCode !== 0) {
    output += `\n\n[Exit code: ${result.exitCode}]`
  }
  return output.trim()
}
