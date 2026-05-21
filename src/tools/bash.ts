import { spawn } from 'child_process'
import { tool } from '@opencode-ai/plugin'
import type { Logger } from '../types'
import type { SandboxContext } from '../sandbox/context'
import { toContainerPath, rewriteOutput } from '../sandbox/path'

const z = tool.schema
const BASH_DEFAULT_TIMEOUT_MS = 120_000

export interface BashToolDeps {
  resolveSandboxForSession: (sessionID: string) => Promise<SandboxContext | null>
  logger: Logger
}

type BashArgs = {
  command: string
  timeout?: number
  workdir?: string
  description: string
}

export function createBashTool(deps: BashToolDeps): ReturnType<typeof tool> {
  return tool({
    description:
      'Executes a given bash command in a persistent shell session with optional timeout. ' +
      'When a sandbox loop is active for this session the command runs inside the docker sandbox; ' +
      'otherwise it runs on the host shell.',
    args: {
      command: z.string().describe('The command to execute'),
      timeout: z.number().int().positive().optional().describe('Optional timeout in milliseconds (default 120000)'),
      workdir: z.string().optional().describe('Working directory to run the command in. Use this instead of `cd`.'),
      description: z.string().describe('Clear, concise description of what this command does in 5-10 words.'),
    },
    execute: async (args, ctx) => {
      const sandbox = await deps.resolveSandboxForSession(ctx.sessionID)

      await ctx.ask({
        permission: 'bash',
        patterns: [args.command],
        always: [args.command],
        metadata: {},
      })

      if (sandbox) {
        return await runInSandbox(args, sandbox, deps)
      }
      return await runOnHost(args, deps)
    },
  })
}

async function runInSandbox(args: BashArgs, sandbox: SandboxContext, deps: BashToolDeps): Promise<string> {
  const { docker, containerName, hostDir } = sandbox
  const cwd = args.workdir ? toContainerPath(args.workdir, hostDir) : undefined
  deps.logger.log(`[bash-tool] sandbox exec container=${containerName} cmd=${args.command.slice(0, 100)}`)

  const result = await docker.exec(containerName, args.command, {
    timeout: args.timeout,
    cwd,
  })

  let out = rewriteOutput(result.stdout, hostDir)
  if (result.stderr && result.exitCode !== 0) {
    out += rewriteOutput(result.stderr, hostDir)
  }
  if (result.exitCode === 124) {
    const timeoutMs = args.timeout ?? BASH_DEFAULT_TIMEOUT_MS
    out += `\n\n<bash_metadata>\nbash tool terminated command after exceeding timeout ${timeoutMs} ms\n</bash_metadata>`
  } else if (result.exitCode !== 0) {
    out += `\n\n[Exit code: ${result.exitCode}]`
  }
  return out.trim()
}

async function runOnHost(args: BashArgs, deps: BashToolDeps): Promise<string> {
  deps.logger.log(`[bash-tool] host exec cmd=${args.command.slice(0, 100)}`)
  const timeoutMs = args.timeout ?? BASH_DEFAULT_TIMEOUT_MS

  return await new Promise<string>((resolve) => {
    const child = spawn('bash', ['-lc', args.command], {
      cwd: args.workdir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2000).unref()
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('close', (code) => {
      clearTimeout(timer)
      let out = stdout
      if (stderr && code !== 0) out += stderr
      if (timedOut) {
        out += `\n\n<bash_metadata>\nbash tool terminated command after exceeding timeout ${timeoutMs} ms\n</bash_metadata>`
      } else if (code !== 0) {
        out += `\n\n[Exit code: ${code}]`
      }
      resolve(out.trim())
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve(`Command failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  })
}
