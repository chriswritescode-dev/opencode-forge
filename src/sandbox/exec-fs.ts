import { toContainerPath, rewriteOutput } from './path'
import type { SandboxMount } from './path'
import type { DockerService } from './docker'

interface SandboxExecutionDeps {
  docker: DockerService
  containerName: string
  hostDir: string
  mounts: SandboxMount[]
}

/**
 * Execute a glob pattern search inside a sandbox container.
 * Returns rewritten file paths with container paths converted back to host paths.
 */
export async function executeSandboxGlob(
  sandbox: SandboxExecutionDeps,
  pattern: string,
  searchPath?: string,
): Promise<string> {
  const { docker, containerName, mounts } = sandbox
  const path = searchPath
    ? toContainerPath(searchPath, mounts)
    : '/workspace'

  const safePattern = pattern.replace(/'/g, "'\\''")
  const cmd = `rg --files --glob '${safePattern}' '${path}' 2>/dev/null | head -100`

  try {
    const result = await docker.exec(containerName, cmd, { timeout: 30000 })

    if (!result.stdout.trim()) return 'No files found'

    const lines = result.stdout.trim().split('\n').filter(Boolean)
    const rewritten = lines.map(l => rewriteOutput(l, mounts))

    let output = rewritten.join('\n')
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
 * Returns rewritten file paths with container paths converted back to host paths.
 */
export async function executeSandboxGrep(
  sandbox: SandboxExecutionDeps,
  pattern: string,
  options?: { path?: string; include?: string },
): Promise<string> {
  const { docker, containerName, mounts } = sandbox
  const searchPath = options?.path
    ? toContainerPath(options.path, mounts)
    : '/workspace'

  const safePattern = pattern.replace(/'/g, "'\\''")
  let cmd = `rg -nH --hidden --no-messages --field-match-separator='|' --regexp '${safePattern}'`
  if (options?.include) {
    const safeInclude = options.include.replace(/'/g, "'\\''")
    cmd += ` --glob '${safeInclude}'`
  }
  cmd += ` '${searchPath}' 2>/dev/null | head -100`

  try {
    const result = await docker.exec(containerName, cmd, { timeout: 30000 })

    if (!result.stdout.trim()) return 'No files found'

    const lines = result.stdout.trim().split('\n').filter(Boolean)
    const grouped = new Map<string, GrepMatch[]>()

    for (const line of lines) {
      const parts = line.split('|')
      if (parts.length < 3) continue
      const filePath = rewriteOutput(parts[0], mounts)
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
