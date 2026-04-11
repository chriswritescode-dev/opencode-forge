import type { Hooks } from '@opencode-ai/plugin'
import type { Logger } from '../types'
import type { GraphService } from '../graph/service'

interface GraphToolHookDeps {
  graphService: GraphService | null
  logger: Logger
  cwd: string
}

/**
 * Extract file paths from tool outputs that may have mutated files.
 * This handles common file-editing tools and bash commands that clearly mutate tracked files.
 */
function extractMutatedPaths(tool: string, output: string, args?: unknown): string[] {
  const paths: string[] = []

  // Handle apply_patch tool - explicitly edits files
  if (tool === 'apply_patch') {
    const argsObj = args as Record<string, unknown> | undefined
    const seen = new Set<string>()
    
    // Primary source: parse patch text from args if present
    // Common keys for patch payload: patch, patchText, patch_text, diff
    const patchKeys = ['patch', 'patchText', 'patch_text', 'diff']
    for (const key of patchKeys) {
      const patchText = (argsObj as Record<string, unknown>)?.[key]
      if (patchText && typeof patchText === 'string') {
        // Look for +++ b/path headers (these indicate the new/modified file)
        const diffRegex = /^\+\+\+ b\/([^\s]+)/gm
        let match: RegExpExecArray | null
        
        while ((match = diffRegex.exec(patchText)) !== null) {
          const path = match[1]
          if (!seen.has(path)) {
            seen.add(path)
            paths.push(path)
          }
        }
        
        // If we found paths in args patch, don't continue to output parsing
        if (paths.length > 0) {
          break
        }
      }
    }
    
    // Secondary: parse patch text from output if args didn't yield paths
    if (paths.length === 0 && output) {
      // Look for +++ b/path headers (these indicate the new/modified file)
      const diffRegex = /^\+\+\+ b\/([^\s]+)/gm
      let match: RegExpExecArray | null
      
      while ((match = diffRegex.exec(output)) !== null) {
        const path = match[1]
        if (!seen.has(path)) {
          seen.add(path)
          paths.push(path)
        }
      }
    }
    
    // Fall back to path arguments if patch parsing yielded nothing
    if (paths.length === 0) {
      const pathKeys = ['path', 'file', 'file_path', 'filepath', 'target']
      for (const key of pathKeys) {
        const value = (argsObj as Record<string, unknown>)?.[key]
        if (value && typeof value === 'string') {
          paths.push(value)
          break
        }
      }
    }
  }

  // Handle bash - only for clear file mutations
  if (tool === 'bash' && output) {
    const argsObj = args as Record<string, unknown> | undefined
    const command = (argsObj?.command as string) || ''
    
    // Detect echo/printf redirecting to files
    const redirectMatch = command.match(/(?:echo|printf|cat)\s+[^>]*>\s*([^\s;]+)/)
    if (redirectMatch?.[1]) {
      paths.push(redirectMatch[1])
    }

    // Detect common file creation commands
    const fileCommands = [
      /touch\s+([^\s;]+)/,
      /cp\s+[^\s]+\s+([^\s;]+)/,
      /mv\s+[^\s]+\s+([^\s;]+)/,
      /sed\s+-i[^>]*\s+([^\s;]+)/,
    ]
    
    for (const regex of fileCommands) {
      const match = command.match(regex)
      if (match?.[1]) {
        paths.push(match[1])
      }
    }
  }

  // Handle write tool
  if (tool === 'write' || tool === 'str_replace_editor') {
    const argsObj = args as Record<string, unknown> | undefined
    
    // Try common path argument keys
    const pathKeys = ['path', 'file', 'file_path', 'filepath']
    for (const key of pathKeys) {
      const value = (argsObj as Record<string, unknown>)?.[key]
      if (value && typeof value === 'string') {
        paths.push(value)
        break
      }
    }
  }

  return paths
}

/**
 * Check if a path is within the project root
 */
function isPathInProject(absPath: string, cwd: string): boolean {
  return absPath.startsWith(cwd)
}

export function createGraphToolAfterHook(deps: GraphToolHookDeps): Hooks['tool.execute.after'] {
  return async (
    input: { tool: string; sessionID: string; callID: string; args?: unknown },
    output: { output?: string },
  ) => {
    // No-op if graph service is disabled
    if (!deps.graphService) {
      return
    }

    const mutatedPaths = extractMutatedPaths(input.tool, output.output ?? '', input.args)
    
    if (mutatedPaths.length === 0) {
      return
    }

    for (const path of mutatedPaths) {
      // Resolve to absolute path
      const absPath = path.startsWith('/') ? path : `${deps.cwd}/${path}`
      
      // Only enqueue if within project
      if (!isPathInProject(absPath, deps.cwd)) {
        deps.logger.debug(`Graph hook: skipping path outside project: ${path}`)
        continue
      }

      deps.logger.debug(`Graph hook: detected file mutation from ${input.tool}: ${path}`)
      deps.graphService.onFileChanged(absPath)
    }
  }
}
