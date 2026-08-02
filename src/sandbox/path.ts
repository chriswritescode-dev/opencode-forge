import { realpathSync } from 'fs'

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

export function isSameOrDescendantPath(path: string, prefix: string): boolean {
  if (path === prefix) return true
  return path.startsWith(prefix + '/')
}

export function isInsideAnyMount(p: string, mounts: SandboxMount[]): boolean {
  for (const mount of mounts) {
    if (isSameOrDescendantPath(p, mount.hostDir) || isSameOrDescendantPath(p, mount.containerDir)) {
      return true
    }
  }
  return false
}
