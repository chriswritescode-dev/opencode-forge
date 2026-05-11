import { spawnSync } from 'child_process'

export interface FinalizeBranchInput {
  worktreeDir: string
  currentBranch: string
  loopName: string
  logger?: { log: (m: string, ...a: unknown[]) => void; error: (m: string, ...a: unknown[]) => void }
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function runGit(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' })
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * Rename the current worktree branch to `opencode/<slug>` with conflict suffixes.
 *
 * Conflict suffixes start at `-2` (never `-1`) and increment up to `-26`.
 * If the current branch already matches the target name, no rename is performed.
 * Returns `{ renamedTo }` on success or `null` if rename failed.
 */
export async function finalizeWorktreeBranch(
  input: FinalizeBranchInput,
): Promise<{ renamedTo: string } | null> {
  const log = input.logger?.log ?? (() => {})
  const logError = input.logger?.error ?? (() => {})

  const slug = slugify(input.loopName)
  if (!slug) {
    logError(`finalizeWorktreeBranch: loopName "${input.loopName}" slugifies to empty string`)
    return null
  }
  const candidates = [`opencode/${slug}`, ...Array.from({ length: 25 }, (_, i) => `opencode/${slug}-${i + 2}`)]

  let targetCandidate: string | null = null

  for (const candidate of candidates) {
    const probe = runGit(['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`], input.worktreeDir)
    if (probe.status !== 0) {
      targetCandidate = candidate
      break
    }
  }

  if (!targetCandidate) {
    logError(`finalizeWorktreeBranch: no available candidate after ${candidates.length} attempts`)
    return null
  }

  if (input.currentBranch === targetCandidate) {
    log(`finalizeWorktreeBranch: branch ${input.currentBranch} already matches target ${targetCandidate}`)
    return { renamedTo: targetCandidate }
  }

  try {
    const result = runGit(['branch', '-m', input.currentBranch, targetCandidate], input.worktreeDir)
    if (result.status !== 0) {
      logError(`finalizeWorktreeBranch: git branch -m failed`, result.stderr)
      return null
    }

    log(`finalizeWorktreeBranch: renamed ${input.currentBranch} -> ${targetCandidate}`)
    return { renamedTo: targetCandidate }
  } catch (err) {
    logError(`finalizeWorktreeBranch: git branch -m threw`, err)
    return null
  }
}
