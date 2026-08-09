import { realpathSync } from 'fs'
import { join } from 'path'

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

/**
 * Directory for per-sandbox env passthrough files. The smolvm backend mounts it read-only at its
 * identical host path so in-guest execs source the same `KEY=value` file the host wrote; the sbx
 * backend consumes the file host-side via `--env-file` and never mounts it.
 */
export function resolveSandboxEnvDir(dataDir: string): string {
  return join(dataDir, 'sandbox-env')
}
