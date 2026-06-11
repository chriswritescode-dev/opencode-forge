import type { LoopState } from '../loop'

type FindingScope =
  | { kind: 'loop'; loopName: string }
  | { kind: 'none' }

export interface LoopScopeResolver {
  resolveLoopName(sessionId: string): string | null
  listActive(): LoopState[]
  getActiveState(name: string): LoopState | null
}

/**
 * Resolves the finding scope for the current context.
 * Resolution order:
 * 1. If sessionId is provided, resolve loop name from loop service
 * 2. Match active loop by worktreeDir or projectDir
 * 3. Return none if no loop scope found
 *
 * @param directory - The directory to match against active loops
 * @param loopService - The loop service for checking active loops
 * @param sessionId - Optional session ID to resolve loop state directly
 * @returns The resolved finding scope
 */
function resolveFindingScope(
  directory: string,
  loopService: LoopScopeResolver,
  sessionId?: string,
): FindingScope {
  // Priority 1: If sessionId is provided, resolve loop name directly
  if (sessionId) {
    const loopName = loopService.resolveLoopName(sessionId)
    if (loopName) {
      return { kind: 'loop', loopName }
    }
  }
  
  // Priority 2: Match active loop by directory
  const active = loopService.listActive()
  const loop = active.find((s) => s.worktreeDir === directory || s.projectDir === directory)
  if (loop?.loopName) {
    return { kind: 'loop', loopName: loop.loopName }
  }
  
  // Priority 3: No scope found
  return { kind: 'none' }
}

/**
 * Resolves the loop name owning the current tool context, using the same
 * resolution order as finding writes: sessionId first, then a directory match
 * against active loops. Returns null when the context is not inside any loop.
 *
 * Read/delete and write paths MUST share this resolver so a finding written
 * under a loop is always visible and deletable from that loop — even when the
 * caller's session is not the loop's registered session (e.g. an audit
 * subagent), in which case the directory fallback still resolves the loop.
 */
export function resolveScopedLoopName(
  directory: string,
  loopService: LoopScopeResolver,
  sessionId?: string,
): string | null {
  const scope = resolveFindingScope(directory, loopService, sessionId)
  return scope.kind === 'loop' ? scope.loopName : null
}

/**
 * Injects the loopName scope field into a JSON object for review findings.
 * Resolution order:
 * 1. If sessionId is provided, use the loop state for that session
 * 2. Match active loop by worktreeDir or projectDir
 *
 * @param value - The object to inject the scope field into
 * @param directory - The directory to check for git branch
 * @param loopService - The loop service for checking active loops
 * @param sessionId - Optional session ID to resolve loop state directly
 */
export function injectScopeField(
  value: unknown,
  directory: string,
  loopService: LoopScopeResolver,
  sessionId?: string,
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return
  
  const scope = resolveFindingScope(directory, loopService, sessionId)
  const record = value as Record<string, unknown>
  
  if (scope.kind === 'loop') {
    record.loopName = scope.loopName
    const loopState = loopService.getActiveState(scope.loopName)
    if (loopState && loopState.totalSections > 0) {
      record.sectionIndex = loopState.currentSectionIndex
    }
  } else {
    record.loopName = null
    record.sectionIndex = null
  }
}
