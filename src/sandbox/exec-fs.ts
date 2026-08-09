import type { SandboxRuntime } from './sbx'

interface SandboxExecutionDeps {
  runtime: SandboxRuntime
  containerName: string
  hostDir: string
  envFile?: string
}

/** Single-quote-escapes `value` (including the wrapping quotes) so it survives a POSIX-sh round-trip. */
export function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * POSIX-sh loop that exports each non-empty `KEY=value` line of the env file without
 * shell-interpreting values. `redirectToken` must already be shell-safe (single-quoted, or a
 * quoted positional such as `"$0"`). Shared by the smolvm runtime preamble and the shell shim
 * so the export semantics exist once.
 */
export function buildEnvFileExportLoop(redirectToken: string): string {
  return `while IFS= read -r __fe || [ -n "$__fe" ]; do [ -n "$__fe" ] && export "$__fe"; done < ${redirectToken}; `
}

/**
 * Execute a glob pattern search inside a sandbox container.
 * Mounts are at identical host paths, so returned paths are emitted verbatim.
 */
export async function executeSandboxGlob(
  sandbox: SandboxExecutionDeps,
  pattern: string,
  searchPath?: string,
): Promise<string> {
  const { runtime, containerName, hostDir, envFile } = sandbox
  const path = searchPath || hostDir

  const cmd = `rg --files --glob ${quoteShellArg(pattern)} ${quoteShellArg(path)} 2>/dev/null | head -100`

  try {
    const result = await runtime.exec(containerName, cmd, { timeout: 30000, envFile, cwd: hostDir })

    if (!result.stdout.trim()) return 'No files found'

    const lines = result.stdout.trim().split('\n').filter(Boolean)

    let output = lines.join('\n')
    if (lines.length >= 100) {
      output += '\n\n(Results are truncated: showing first 100 results. Consider using a more specific path or pattern.)'
    }
    return output
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return `Glob failed: ${message}`
  }
}

interface GrepMatch {
  line: number
  text: string
}

/**
 * Execute a grep/regex search inside a sandbox container.
 * Mounts are at identical host paths, so returned paths are emitted verbatim.
 */
export async function executeSandboxGrep(
  sandbox: SandboxExecutionDeps,
  pattern: string,
  options?: { path?: string; include?: string },
): Promise<string> {
  const { runtime, containerName, hostDir, envFile } = sandbox
  const searchPath = options?.path || hostDir

  let cmd = `rg -nH --hidden --no-messages --field-match-separator='|' --regexp ${quoteShellArg(pattern)}`
  if (options?.include) {
    cmd += ` --glob ${quoteShellArg(options.include)}`
  }
  cmd += ` ${quoteShellArg(searchPath)} 2>/dev/null | head -100`

  try {
    const result = await runtime.exec(containerName, cmd, { timeout: 30000, envFile, cwd: hostDir })

    if (!result.stdout.trim()) return 'No files found'

    const lines = result.stdout.trim().split('\n').filter(Boolean)
    const grouped = new Map<string, GrepMatch[]>()

    for (const line of lines) {
      const parts = line.split('|')
      if (parts.length < 3) continue
      const filePath = parts[0]
      const lineNum = parseInt(parts[1], 10)
      const text = parts.slice(2).join('|')
      const truncatedText = text.length > 2000 ? text.slice(0, 1997) + '...' : text
      if (!grouped.has(filePath)) grouped.set(filePath, [])
      grouped.get(filePath)!.push({ line: lineNum, text: truncatedText })
    }

    const outputParts: string[] = []
    outputParts.push(`Found ${lines.length} matches`)

    for (const [filePath, matches] of grouped) {
      outputParts.push(`${filePath}:`)
      for (const m of matches) {
        outputParts.push(`  Line ${m.line}: ${m.text}`)
      }
      outputParts.push('')
    }

    if (lines.length >= 100) {
      outputParts.push('(Results truncated: showing 100 of possibly more matches. Consider using a more specific path or pattern.)')
    }

    return outputParts.join('\n')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return `Grep failed: ${message}`
  }
}
