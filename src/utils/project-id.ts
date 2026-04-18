import { execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'

const cache = new Map<string, string | null>()

export function getGitProjectId(dir?: string): string | null {
  const cwd = dir ?? process.cwd()
  if (cache.has(cwd)) return cache.get(cwd) ?? null

  const result = computeGitProjectId(cwd)
  cache.set(cwd, result)
  return result
}

function computeGitProjectId(cwd: string): string | null {
  try {
    const execOpts = {
      encoding: 'utf-8' as const,
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
    }
    const rawCommonDir = execSync('git rev-parse --git-common-dir', execOpts).trim()
    if (!rawCommonDir) return null
    const commonDir = isAbsolute(rawCommonDir) ? rawCommonDir : resolve(cwd, rawCommonDir)

    const cacheFile = join(commonDir, 'opencode')
    if (existsSync(cacheFile)) {
      const cachedId = readFileSync(cacheFile, 'utf-8').trim()
      if (cachedId) return cachedId
    }

    const output = execSync('git rev-list --max-parents=0 --all', execOpts).trim()
    if (!output) return null
    const commits = output.split('\n').filter(Boolean).sort()
    return commits[0] || null
  } catch {
    return null
  }
}
