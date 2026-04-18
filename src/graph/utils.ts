import { readdirSync } from 'fs'
import { stat } from 'fs/promises'
import { join, extname } from 'path'
import type { SymbolKind } from './types'
import { INDEXABLE_EXTENSIONS } from './constants'

/** Common directories to ignore when scanning */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  'nuxt',
  'vendor',
  'venv',
  '__pycache__',
  '.cache',
  'target',
  'out',
  '.idea',
  '.vscode',
])

/** File extensions to ignore */
export const IGNORED_EXTS = new Set([
  '.min.js',
  '.bundle.js',
  '.d.ts',
  '.map',
  '.lock',
  '.yarn',
])

interface CollectedFile {
  path: string
  mtimeMs: number
}

const MAX_FILE_SIZE = 500_000
const MAX_DEPTH = 10
const WALK_FILE_CAP = 50_000

interface CollectResult {
  files: CollectedFile[]
  warning?: string
}

/**
 * Collects a lightweight fingerprint of the repository for startup freshness checks.
 * Returns file count and max mtime without reading file contents.
 * Excludes the graph cache directory to avoid counting the metadata file itself.
 * 
 * @param dir - Directory to fingerprint (usually cwd)
 * @param graphCacheDir - Optional graph cache directory to exclude. If not provided, 
 *                        excludes common graph cache locations.
 * @returns Object with fileCount and maxMtimeMs
 */
export async function collectIndexFingerprint(
  dir: string,
  graphCacheDir?: string,
): Promise<{ fileCount: number; maxMtimeMs: number }> {
  // Try git ls-files first
  const gitFiles = await collectFilesViaGit(dir)
  if (gitFiles) {
    let maxMtimeMs = 0
    let filteredCount = 0
    for (const file of gitFiles) {
      // Skip graph cache files if graphCacheDir is provided
      if (graphCacheDir && file.path.startsWith(graphCacheDir)) {
        continue
      }
      filteredCount++
      if (file.mtimeMs > maxMtimeMs) {
        maxMtimeMs = file.mtimeMs
      }
    }
    return {
      fileCount: filteredCount,
      maxMtimeMs: maxMtimeMs,
    }
  }

  // Fallback walk - collect only mtime, not full file data
  const collected: CollectedFile[] = []
  await collectFilesWalk(dir, 0, undefined, collected)
  
  // Filter out graph cache files if graphCacheDir is provided
  const filtered = graphCacheDir 
    ? collected.filter(file => !file.path.startsWith(graphCacheDir))
    : collected
  
  let maxMtimeMs = 0
  for (const file of filtered) {
    if (file.mtimeMs > maxMtimeMs) {
      maxMtimeMs = file.mtimeMs
    }
  }
  
  return {
    fileCount: filtered.length,
    maxMtimeMs: maxMtimeMs,
  }
}

/**
 * Collect files from a directory - async version using git ls-files first
 */
export async function collectFilesAsync(
  dir: string,
): Promise<CollectResult> {
  // Try git ls-files first
  const gitFiles = await collectFilesViaGit(dir)
  if (gitFiles) {
    return { files: gitFiles }
  }

  // Fallback walk
  const collected: CollectedFile[] = []
  let hitCap = false
  const walkDone = collectFilesWalk(dir, 0, undefined, collected).then(() => {
    hitCap = collected.length >= WALK_FILE_CAP
  })

  const timedOut = await Promise.race([
    walkDone.then(() => false),
    new Promise<true>((r) => setTimeout(() => r(true), 60_000)),
  ])

  const warning = timedOut
    ? `Walk timeout - indexed ${String(collected.length)} of possibly more files (60s limit)`
    : hitCap
      ? `Large directory - capped file walk at ${String(WALK_FILE_CAP)} files`
      : undefined

  return { files: collected, warning }
}

async function collectFilesViaGit(dir: string): Promise<CollectedFile[] | null> {
  try {
    const proc = Bun.spawn(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const code = await Promise.race([
      proc.exited,
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 30_000)),
    ])
    if (code === 'timeout') {
      proc.kill()
      return null
    }
    const text = await new Response(proc.stdout).text()
    if (code !== 0) return null

    const files: CollectedFile[] = []
    for (const line of text.split('\n')) {
      if (!line) continue
      const ext = extname(line).toLowerCase()
      if (!(ext in INDEXABLE_EXTENSIONS)) continue
      const fullPath = join(dir, line)
      try {
        const s = await stat(fullPath)
        if (s.size < MAX_FILE_SIZE) files.push({ path: fullPath, mtimeMs: s.mtimeMs })
      } catch {}
      if (files.length % 50 === 0) await new Promise<void>((r) => setTimeout(r, 0))
    }
    return files
  } catch {
    return null
  }
}

async function collectFilesWalk(
  dir: string,
  depth: number,
  counter?: { n: number },
  out?: CollectedFile[],
): Promise<CollectedFile[]> {
  if (depth > MAX_DEPTH) return []
  const ctx = counter ?? { n: 0 }
  const files = out ?? []
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (ctx.n >= WALK_FILE_CAP) break
      if (entry.name.startsWith('.') && entry.name !== '.') continue
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          await collectFilesWalk(fullPath, depth + 1, ctx, files)
        }
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase()
        if (ext in INDEXABLE_EXTENSIONS) {
          try {
            const s = await stat(fullPath)
            if (s.size < MAX_FILE_SIZE) {
              files.push({ path: fullPath, mtimeMs: s.mtimeMs })
              ctx.n++
            }
          } catch {}
        }
      }
      if (ctx.n % 50 === 0) await new Promise<void>((r) => setTimeout(r, 0))
    }
  } catch {}
  return files
}

/**
 * Check if file is a barrel file
 */
export function isBarrelFile(path: string): boolean {
  const name = path.split('/').pop()?.toLowerCase() || ''
  return name === 'index.ts' || 
         name === 'index.tsx' || 
         name === 'index.js' ||
         name === 'mod.rs' ||
         name === 'index.py' ||
         name === '__init__.py'
}

/**
 * Extract signature from a line
 */
export function extractSignature(lines: string[], lineIdx: number, kind: string): string | null {
  const line = lines[lineIdx]
  if (!line) return null

  let sig = line.trimStart()

  if (kind === 'function' || kind === 'method') {
    if (!sig.includes(')') && !sig.includes('{') && !sig.includes('=>')) {
      for (let i = 1; i <= 2; i++) {
        const next = lines[lineIdx + i]
        if (!next) break
        sig += ` ${next.trim()}`
        if (next.includes(')') || next.includes('{')) break
      }
    }
  }

  const braceIdx = sig.indexOf('{')
  if (braceIdx > 0) sig = sig.slice(0, braceIdx).trimEnd()

  sig = sig.replace(/\s*[{:]\s*$/, '').trimEnd()

  if (sig.length > 120) sig = `${sig.slice(0, 117)}...`

  return sig || null
}

/**
 * Get kind tag prefix
 */
export function kindTag(kind: SymbolKind): string {
  switch (kind) {
    case 'function':
    case 'method':
      return 'f:'
    case 'class':
      return 'c:'
    case 'interface':
      return 'i:'
    case 'type':
      return 't:'
    case 'variable':
    case 'constant':
      return 'v:'
    case 'enum':
      return 'e:'
    default:
      return ''
  }
}


