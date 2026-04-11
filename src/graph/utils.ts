import { existsSync, readdirSync } from 'fs'
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
 * Collect files from a directory recursively (sync version)
 */
export function collectFiles(
  dir: string,
  maxFiles = 5000,
  extensions?: string[],
): string[] {
  const files: string[] = []
  
  function walk(currentDir: string): void {
    if (!existsSync(currentDir)) return
    
    const entries = readdirSync(currentDir, { withFileTypes: true })
    
    for (const entry of entries) {
      if (files.length >= maxFiles) return
      
      const fullPath = join(currentDir, entry.name)
      
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        if (entry.name.startsWith('.')) continue
        
        walk(fullPath)
      } else if (entry.isFile()) {
        if (extensions && !extensions.some(ext => entry.name.endsWith(ext))) {
          continue
        }
        
        const ext = extname(entry.name).toLowerCase()
        if (IGNORED_EXTS.has(ext)) continue
        if (entry.name.endsWith('.min.js') || entry.name.endsWith('.bundle.js')) continue
        
        files.push(fullPath)
      }
    }
  }
  
  walk(dir)
  return files.slice(0, maxFiles)
}

/**
 * Estimate token count for a string
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5)
}

/**
 * Get file extension from path
 */
export function getExtension(path: string): string {
  return extname(path).toLowerCase()
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
 * Normalize path separators
 */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

/**
 * Make path relative to a base directory
 */
export function makeRelative(path: string, baseDir: string): string {
  const normalized = normalizePath(path)
  const normalizedBase = normalizePath(baseDir)
  
  if (normalized.startsWith(normalizedBase)) {
    return normalized.slice(normalizedBase.length).replace(/^\/+/, '')
  }
  
  return normalized
}

/**
 * Extract a doc comment immediately above the symbol line
 */
export function extractDocComment(lines: string[], symbolLineIdx: number): string | null {
  const symbolLine = lines[symbolLineIdx]
  if (symbolLine && /^\s*(def |class |async def )/.test(symbolLine)) {
    for (let k = symbolLineIdx + 1; k < Math.min(symbolLineIdx + 3, lines.length); k++) {
      const trimmed = lines[k]?.trim() ?? ''
      const tripleMatch = /^("""|''')(.*)/.exec(trimmed)
      if (tripleMatch) {
        const quote = tripleMatch[1] as string
        const rest = tripleMatch[2] ?? ''
        if (rest.includes(quote)) {
          return trimDocLine(rest.slice(0, rest.indexOf(quote)))
        }
        const docLines = [rest]
        for (let j = k + 1; j < Math.min(k + 10, lines.length); j++) {
          const dl = lines[j]?.trim() ?? ''
          if (dl.includes(quote)) {
            docLines.push(dl.slice(0, dl.indexOf(quote)))
            break
          }
          docLines.push(dl)
        }
        return trimDocLine(docLines.filter(Boolean).join(' '))
      }
      if (trimmed) break
    }
  }

  for (let k = symbolLineIdx - 1; k >= Math.max(0, symbolLineIdx - 2); k--) {
    const trimmed = lines[k]?.trim() ?? ''
    if (trimmed === '' || trimmed === '*/' || trimmed.startsWith('*/')) continue
    if (trimmed.endsWith('*/')) {
      const m = /^\/\*\*?\s*(.*?)\s*\*\/$/.exec(trimmed)
      if (m?.[1]) return trimDocLine(m[1])
    }
    if (trimmed.startsWith('/**') || trimmed.startsWith('/*')) {
      const collected: string[] = []
      const firstContent = trimmed
        .replace(/^\/\*\*?\s*/, '')
        .replace(/\*\/\s*$/, '')
        .trim()
      if (firstContent) collected.push(firstContent)
      for (let j = k + 1; j < symbolLineIdx; j++) {
        const cl = (lines[j]?.trim() ?? '')
          .replace(/^\*\s?/, '')
          .replace(/\*\/\s*$/, '')
          .trim()
        if (cl.startsWith('@')) break
        if (cl) collected.push(cl)
      }
      if (collected.length > 0) return trimDocLine(collected.join(' '))
    }
    break
  }

  let commentEnd = symbolLineIdx - 1
  if (commentEnd >= 0 && (lines[commentEnd]?.trim() ?? '') === '') commentEnd--
  if (commentEnd >= 0) {
    const first = lines[commentEnd]?.trim() ?? ''
    if (first.startsWith('///') || first.startsWith('//')) {
      const isTriple = first.startsWith('///')
      const prefix = isTriple ? '///' : '//'
      const collected: string[] = []
      let k = commentEnd
      while (k >= 0 && (lines[k]?.trim() ?? '').startsWith(prefix)) {
        collected.unshift((lines[k]?.trim() ?? '').slice(prefix.length).trim())
        k--
      }
      if (collected.length > 0) return trimDocLine(collected.join(' '))
    }

    if (first.startsWith('#') && !first.startsWith('#!')) {
      const collected: string[] = []
      let k = commentEnd
      while (k >= 0 && (lines[k]?.trim() ?? '').startsWith('#')) {
        collected.unshift((lines[k]?.trim() ?? '').slice(1).trim())
        k--
      }
      if (collected.length > 0) return trimDocLine(collected.join(' '))
    }
  }

  return null
}

function trimDocLine(text: string): string | null {
  let s = text.replace(/\s+/g, ' ').trim()
  if (!s || s.length < 5) return null
  if (s.length > 80) s = `${s.slice(0, 77)}...`
  return s
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

/**
 * Generate synthetic summary for a symbol
 */
export function generateSyntheticSummary(name: string, kind: string, filePath: string): string {
  const words = splitIdentifier(name)
  const parts = filePath.split('/')
  const dir = parts.length >= 2 ? parts[parts.length - 2] : ''
  const kindLabel = kind === 'function' || kind === 'method' ? kind : kind
  const summary = `${dir ? `[${dir}] ` : ''}${kindLabel}: ${words.join(' ')}`
  return summary.length > 80 ? `${summary.slice(0, 77)}...` : summary
}

function splitIdentifier(name: string): string[] {
  if (name.includes('_'))
    return name
      .split('_')
      .filter(Boolean)
      .map((w) => w.toLowerCase())
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(' ')
    .map((w) => w.toLowerCase())
}

/**
 * Get directory group for a file path
 */
export function getDirGroup(filePath: string): string | null {
  const parts = filePath.split('/')
  if (parts.length < 2) return null
  return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : (parts[0] ?? null)
}

/**
 * Convert barrel file path to directory path
 */
const BARREL_RE = /\/(index\.(ts|js|tsx|mts|mjs)|__init__\.py|mod\.rs)$/

export function barrelToDir(barrelPath: string): string {
  return barrelPath.replace(BARREL_RE, '')
}
