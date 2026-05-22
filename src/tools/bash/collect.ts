import os from 'os'
import path from 'path'
import { statSync } from 'fs'
import type { Node } from 'web-tree-sitter'
import { commands, parts, source, unquote, redirectedOnly } from './parse'
import { prefix as arityPrefix } from './arity'

export interface Scan { dirs: string[]; patterns: string[]; always: string[] }

const CWD = new Set(['cd', 'chdir', 'popd', 'pushd'])
const FILES = new Set([...CWD, 'rm', 'cp', 'mv', 'mkdir', 'touch', 'chmod', 'chown', 'cat'])

function home(text: string): string {
  if (text === '~') return os.homedir()
  if (text.startsWith('~/')) return path.join(os.homedir(), text.slice(2))
  return text
}

function dynamic(text: string): boolean {
  if (text.startsWith('(')) return true
  if (text.includes('$(') || text.includes('${') || text.includes('`')) return true
  return text.includes('$')
}

function pathPrefix(text: string): string | undefined {
  const m = /[?*[]/.exec(text)
  if (!m) return text
  if (m.index === 0) return undefined
  return text.slice(0, m.index)
}

function pathArgs(list: { text: string }[]): string[] {
  return list.slice(1)
    .map(p => p.text)
    .filter(text => !text.startsWith('-') && !(list[0]?.text === 'chmod' && text.startsWith('+')))
}

function isDirSafe(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}

function argPath(arg: string, cwd: string): string | undefined {
  const text = home(unquote(arg))
  const file = pathPrefix(text)
  if (!file || dynamic(file)) return undefined
  return path.resolve(cwd, file)
}

function containsPath(target: string, root: string): boolean {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function collect(root: Node, cwd: string): Scan {
  const dirs = new Set<string>()
  const patterns = new Set<string>()
  const always = new Set<string>()
  let hasCommand = false
  for (const node of commands(root)) {
    hasCommand = true
    const parsed = parts(node)
    const tokens = parsed.map(p => p.text)
    const cmd = tokens[0]
    if (cmd && FILES.has(cmd)) {
      for (const arg of pathArgs(parsed)) {
        const resolved = argPath(arg, cwd)
        if (!resolved || containsPath(resolved, cwd)) continue
        const dir = isDirSafe(resolved) ? resolved : path.dirname(resolved)
        dirs.add(dir)
      }
    }
    if (tokens.length && (!cmd || !CWD.has(cmd))) {
      patterns.add(source(node))
      always.add(arityPrefix(tokens).join(' ') + ' *')
    }
  }
  for (const node of redirectedOnly(root)) {
    patterns.add(node.text.trim())
    always.add(node.text.trim())
  }
  // Fallback: when no command nodes found (e.g. redirection-only like "> marker"),
  // still require permission using the raw command string.
  if (!hasCommand && patterns.size === 0) {
    const trimmed = root.text.trim()
    if (trimmed.length > 0) {
      patterns.add(trimmed)
      always.add(trimmed)
    }
  }
  return { dirs: Array.from(dirs), patterns: Array.from(patterns), always: Array.from(always) }
}
