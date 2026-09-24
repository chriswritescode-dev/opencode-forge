import { realpathSync } from 'fs'
import { basename, dirname, join } from 'path'

export interface SandboxMount {
  hostDir: string
  containerDir: string
  readOnly?: boolean
}

export function canonicalizePath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export function canonicalizeExistingPath(path: string): string {
  const missing: string[] = []
  let current = path
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return path
      missing.push(basename(current))
      current = parent
    }
  }
}

export function isSameOrDescendantPath(path: string, prefix: string): boolean {
  if (path === prefix) return true
  return path.startsWith(prefix + '/')
}

export function findContainingMount(p: string, mounts: SandboxMount[]): SandboxMount | undefined {
  let best: SandboxMount | undefined
  let bestLength = -1
  for (const mount of mounts) {
    for (const root of [mount.hostDir, mount.containerDir]) {
      if (root.length > bestLength && isSameOrDescendantPath(p, root)) {
        best = mount
        bestLength = root.length
      }
    }
  }
  return best
}

export function isInsideAnyMount(p: string, mounts: SandboxMount[]): boolean {
  return findContainingMount(p, mounts) !== undefined
}
