import type { Hooks } from '@opencode-ai/plugin'
import type { Logger } from '../types'
import type { GraphService } from '../graph/service'
import { join, isAbsolute, normalize, resolve, sep } from 'path'
import { execFileSync } from 'child_process'

interface GraphToolHookDeps {
  graphService: GraphService | null
  logger: Logger
  cwd: string
}

/**
 * Map storing pre-command git revision snapshots keyed by callID.
 * Only populated for bash commands that are branch-change candidates.
 * Exported for testing purposes.
 */
export const pendingBranchSnapshots = new Map<string, { cwd: string; branch: string | null; headRef: string | null }>()

/**
 * Resolves the effective git working directory for a bash tool call.
 * - Uses args.workdir when present
 * - Falls back to the plugin/project cwd
 * - Normalizes relative paths against the project root
 */
function resolveBashWorkdir(args: unknown, projectCwd: string): string {
  const workdirArg = (args as Record<string, unknown>)?.workdir as string | undefined
  
  if (workdirArg) {
    // Normalize and resolve workdir against project root if relative
    const normalized = normalize(workdirArg)
    return isAbsolute(normalized) ? normalized : join(projectCwd, normalized)
  }
  
  return projectCwd
}

/**
 * Determines whether a bash command is worth branch tracking.
 * Initial command set includes git branch-changing commands.
 * Excludes file restoration commands with explicit -- separator like `git checkout -- <path>`.
 * For bare `git checkout <arg>` without --, we conservatively track it and let the
 * after-hook compare pre/post branch state to determine if a rescan is needed.
 */
export function isBranchChangeCommand(args: unknown): boolean {
  const command = ((args as Record<string, unknown>)?.command as string) || ''
  
  if (!command.trim()) {
    return false
  }
  
  // Normalize command by trimming whitespace
  const trimmed = command.trim()
  
  // git switch always changes branch
  if (/^git\s+switch\s+/.test(trimmed)) {
    return true
  }
  
  // git worktree add changes the worktree context
  if (/^git\s+worktree\s+add\s+/.test(trimmed)) {
    return true
  }
  
  // git checkout can switch branches OR restore files
  // Branch checkout: git checkout <branch> (no -- separator)
  // File restore: git checkout -- <path> or git checkout <rev> -- <path>
  // We conservatively track bare `git checkout <arg>` (without --) because
  // we can't reliably distinguish branches from file paths without running git,
  // and we don't have the working directory context here.
  // The after-hook will compare pre/post branch state to determine the actual behavior.
  if (/^git\s+checkout\s+(.+)$/.test(trimmed)) {
    const checkoutArgs = trimmed.match(/^git\s+checkout\s+(.+)$/)?.[1] || ''
    // If it has -- separator, it's definitely file restoration
    if (checkoutArgs.includes('--')) {
      return false
    }
    // Bare checkout without --: conservatively track it
    // The after-hook will determine if branch actually changed
    return true
  }
  
  return false
}

/**
 * Extract file paths from git checkout file restoration commands.
 * Handles patterns like:
 * - git checkout -- <path>
 * - git checkout HEAD -- <path>
 * - git checkout <commit> -- <path>
 * - git checkout <path> (unambiguous file path without --)
 * Returns empty array if not a checkout file restore command.
 */
function extractCheckoutPaths(args: unknown, workdir: string): string[] {
  const command = ((args as Record<string, unknown>)?.command as string) || ''
  
  if (!command.trim()) {
    return []
  }
  
  const trimmed = command.trim()
  
  // Match git checkout with -- separator (file restoration)
  // Patterns: git checkout -- <path>, git checkout HEAD -- <path>, git checkout <commit> -- <path>
  const restoreMatch = trimmed.match(/^git\s+checkout\s+(?:[^\s-]+\s+)?--\s+(.+)$/)
  if (restoreMatch) {
    const pathsStr = restoreMatch[1]
    // Split by whitespace to handle multiple paths
    return pathsStr.split(/\s+/).filter(p => p.length > 0)
  }
  
  // Match git checkout <path> without -- separator
  // This is ambiguous: could be a branch or a file path
  // Use git to reliably check if the argument is a valid branch/ref
  const checkoutMatch = trimmed.match(/^git\s+checkout\s+(.+)$/)
  if (checkoutMatch) {
    const checkoutArgs = checkoutMatch[1]
    // Use git rev-parse to check if it's a valid ref/branch
    // If rev-parse succeeds, it's a branch/ref, not a file path
    try {
      execFileSync('git', ['rev-parse', '--verify', checkoutArgs, '--'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: workdir,
      })
      // It's a valid ref/branch, not a file path
      return []
    } catch {
      // rev-parse failed, so it's likely a file path -> extract it
      return [checkoutArgs]
    }
  }
  
  return []
}

/**
 * Reads the current git HEAD revision (commit hash) from the resolved working directory using git.
 * Returns null when the directory is not a repo or the revision cannot be determined.
 */
function getCurrentHeadRef(workdir: string): string | null {
  try {
    const result = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: workdir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return result.trim()
  } catch {
    // Not a git repo, or git command failed
    return null
  }
}

/**
 * Reads the current branch name from the resolved working directory using git.
 * Returns null when the directory is not a repo or the branch cannot be determined.
 */
function getCurrentBranch(workdir: string): string | null {
  try {
    const result = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: workdir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return result.trim()
  } catch {
    // Not a git repo, or git command failed
    return null
  }
}

/**
 * Gets the list of changed file paths between two git revisions.
 * Uses git diff --name-only with the specified diff filter to detect additions, deletions, and modifications.
 * Returns an empty array if the refs are equal, invalid, or if git command fails.
 */
function getChangedPathsBetweenRefs(workdir: string, prevRef: string, nextRef: string): string[] {
  if (prevRef === nextRef) {
    return []
  }
  
  try {
    const result = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACDMRT', prevRef, nextRef], {
      cwd: workdir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    
    const output = result.trim()
    if (!output) {
      return []
    }
    
    // Split by newlines and filter out empty entries
    return output.split('\n').filter((p: string) => p.length > 0)
  } catch {
    // Git command failed (e.g., invalid refs, not a repo)
    return []
  }
}

/**
 * Extract file paths from tool outputs that may have mutated files.
 * This handles common file-editing tools and bash commands that clearly mutate tracked files.
 */
function extractMutatedPaths(tool: string, output: string, args: unknown): string[] {
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
 * Check if a path is within the project root using proper path containment.
 * Uses realpath-like normalization to avoid prefix collisions.
 * Example: /Users/chris/development/opencode-forge should not contain /Users/chris/development/opencode-forge-backup
 */
function isPathInProject(absPath: string, cwd: string): boolean {
  const normalizedPath = resolve(absPath)
  const normalizedCwd = resolve(cwd)
  // Ensure cwd ends with separator for proper containment check (cross-platform)
  const cwdWithSep = normalizedCwd.endsWith(sep)
    ? normalizedCwd 
    : normalizedCwd + sep
  return normalizedPath === normalizedCwd || normalizedPath.startsWith(cwdWithSep)
}

/**
 * Check if a workdir is within the project root using proper path containment.
 */
function isWorkdirInProject(workdir: string, projectCwd: string): boolean {
  return isPathInProject(workdir, projectCwd)
}

/**
 * Creates a before-hook for graph tool execution that captures pre-command branch state.
 * Only inspects bash tool calls that are branch-change candidates.
 */
export function createGraphToolBeforeHook(deps: GraphToolHookDeps): Hooks['tool.execute.before'] {
  return async (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: unknown },
  ) => {
    // No-op if graph service is disabled
    if (!deps.graphService) {
      return
    }
    
    // Only inspect bash tool calls
    if (input.tool !== 'bash') {
      return
    }
    
    // Check if this is a branch-change candidate command
    if (!isBranchChangeCommand(output.args)) {
      return
    }
    
    // Resolve the effective working directory for this bash call
    const workdir = resolveBashWorkdir(output.args, deps.cwd)
    
    // Only track branch changes within the project worktree
    // Skip if workdir is outside the project root (uses proper path containment)
    if (!isWorkdirInProject(workdir, deps.cwd)) {
      deps.logger.debug(`Graph hook: skipping branch tracking for workdir outside project: ${workdir}`)
      return
    }
    
    // Capture the pre-command branch name and HEAD revision (may be null if not in a repo)
    const branch = getCurrentBranch(workdir)
    const headRef = getCurrentHeadRef(workdir)

    // Store the snapshot keyed by callID
    pendingBranchSnapshots.set(input.callID, {
      cwd: workdir,
      branch,
      headRef,
    })

    deps.logger.debug(`Graph hook: captured pre-command branch snapshot for ${input.callID}: branch=${branch ?? 'null'}, headRef=${headRef ?? 'null'}, cwd=${workdir}`)
  }
}

export function createGraphToolAfterHook(deps: GraphToolHookDeps): Hooks['tool.execute.after'] {
  return async (
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title: string; output: string; metadata: unknown },
  ) => {
    // No-op if graph service is disabled
    if (!deps.graphService) {
      return
    }
    
    // Check for pending branch snapshot first
    const snapshot = pendingBranchSnapshots.get(input.callID)
    
    // Always clear the pending snapshot entry for the callID
    pendingBranchSnapshots.delete(input.callID)
    
    if (snapshot) {
      // This was a branch-change candidate - check if branch name actually changed
      const nextBranch = getCurrentBranch(snapshot.cwd)
      const branchChanged = snapshot.branch !== null
        && nextBranch !== null
        && snapshot.branch !== nextBranch

      if (branchChanged) {
        // Branch changed - use commit hashes to compute the diff for incremental update
        const nextHeadRef = getCurrentHeadRef(snapshot.cwd)
        if (snapshot.headRef && nextHeadRef && snapshot.headRef !== nextHeadRef) {
          deps.logger.log(`Graph hook: branch switch detected (${snapshot.branch} -> ${nextBranch}), enqueuing changed files`)
          const changedPaths = getChangedPathsBetweenRefs(snapshot.cwd, snapshot.headRef, nextHeadRef)
          for (const relPath of changedPaths) {
            const absPath = resolve(snapshot.cwd, relPath)
            if (isPathInProject(absPath, deps.cwd)) {
              deps.graphService.onFileChanged(absPath)
            }
          }
        } else {
          deps.logger.debug(`Graph hook: branch switch detected (${snapshot.branch} -> ${nextBranch}) but commits are identical, no files to update`)
        }
        return
      }

      // Branch did not change - check for file restoration commands first, then fall through to per-file mutation path
      deps.logger.debug(`Graph hook: no branch change for ${input.callID}, checking file mutations`)
      
      // Extract file paths from git checkout file restoration commands
      const workdir = resolveBashWorkdir(input.args, deps.cwd)
      const checkoutPaths = extractCheckoutPaths(input.args, workdir)
      if (checkoutPaths.length > 0) {
        deps.logger.debug(`Graph hook: detected git checkout file restoration, enqueuing ${checkoutPaths.length} file(s)`)
        for (const path of checkoutPaths) {
          const absPath = path.startsWith('/') ? path : `${snapshot.cwd}/${path}`
          if (isPathInProject(absPath, deps.cwd)) {
            deps.graphService.onFileChanged(absPath)
          }
        }
        return
      }
    }
    
    // Extract per-file mutations (existing behavior)
    const mutatedPaths: string[] = extractMutatedPaths(input.tool, output.output ?? '', input.args)
    
    // Also check for git checkout file restoration commands (these don't have branch snapshots)
    const workdir = resolveBashWorkdir(input.args, deps.cwd)
    const checkoutPaths = extractCheckoutPaths(input.args, workdir)
    if (checkoutPaths.length > 0) {
      for (const path of checkoutPaths) {
        const absPath = path.startsWith('/') ? path : `${workdir}/${path}`
        if (isPathInProject(absPath, deps.cwd)) {
          mutatedPaths.push(absPath)
        }
      }
    }
    
    if (mutatedPaths.length === 0) {
      return
    }

    // Resolve the effective working directory for bash calls to correctly resolve relative paths
    const bashWorkdir = input.tool === 'bash' ? workdir : deps.cwd

    for (const path of mutatedPaths) {
      // Checkout paths are already absolute, others need resolution
      const absPath = path.startsWith('/') ? path : resolve(bashWorkdir, path)
      
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
