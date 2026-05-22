import { spawn } from 'child_process'
import { tail, preview, writeOverflow } from './truncate'
import type { Limits } from './truncate'
import type { Logger } from '../../types'

const BASH_DEFAULT_TIMEOUT_MS = 120_000

export interface ExecCtx {
  messageID: string
  abort?: AbortSignal
  metadata?: (m: { metadata: { output: string; description: string } }) => void
}

export interface BashArgs {
  command: string
  timeout?: number
  workdir?: string
  description: string
}

export interface ExecDeps {
  logger: Logger
  dataDir: string
}

export async function runOnHost(
  args: BashArgs,
  deps: ExecDeps,
  ctx: ExecCtx,
  limits: Limits,
  cwd?: string,
): Promise<string> {
  const timeoutMs = args.timeout ?? BASH_DEFAULT_TIMEOUT_MS
  const callID = ctx.messageID + '-' + Date.now()
  deps.logger.log(`[bash-tool] host exec cmd=${args.command.slice(0, 100)}`)

  return await new Promise<string>((resolve) => {
    const child = spawn('bash', ['-lc', args.command], {
      cwd: cwd ?? args.workdir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let last = ''
    let timedOut = false
    let aborted = false

    const onAbort = () => {
      aborted = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 3000).unref()
    }
    if (ctx.abort?.aborted) onAbort()
    else ctx.abort?.addEventListener('abort', onAbort, { once: true })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 3000).unref()
    }, timeoutMs)

    const updateMeta = (chunk: string) => {
      last = preview(last + chunk)
      ctx.metadata?.({ metadata: { output: last, description: args.description } })
    }
    child.stdout?.on('data', (b: Buffer) => { const s = b.toString('utf8'); stdout += s; updateMeta(s) })
    child.stderr?.on('data', (b: Buffer) => { const s = b.toString('utf8'); stderr += s; updateMeta(s) })

    child.on('close', (code) => {
      clearTimeout(timer)
      ctx.abort?.removeEventListener('abort', onAbort)
      const raw = stdout + (stderr && code !== 0 ? stderr : '')
      const end = tail(raw, limits.maxLines, limits.maxBytes)
      let out = end.text || '(no output)'
      if (end.cut) {
        const file = writeOverflow(deps.dataDir, callID, raw)
        out = `...output truncated...\n\nFull output saved to: ${file}\n\n` + out
      }
      const meta: string[] = []
      if (timedOut) meta.push(`bash tool terminated command after exceeding timeout ${timeoutMs} ms`)
      if (aborted && !timedOut) meta.push('User aborted the command')
      if (meta.length) out += `\n\n<bash_metadata>\n${meta.join('\n')}\n</bash_metadata>`
      else if (code !== 0 && !timedOut) out += `\n\n[Exit code: ${code}]`
      resolve(out.trim())
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      ctx.abort?.removeEventListener('abort', onAbort)
      resolve(`Command failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  })
}
