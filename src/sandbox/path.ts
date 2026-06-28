export interface SandboxMount {
  hostDir: string
  containerDir: string
  readOnly?: boolean
}

function hasPrefix(path: string, prefix: string): boolean {
  if (path === prefix) return true
  return path.startsWith(prefix + '/')
}

export function toContainerPath(hostPath: string, mounts: SandboxMount[]): string {
  for (const mount of mounts) {
    if (hasPrefix(hostPath, mount.containerDir)) {
      return hostPath
    }
  }

  let bestMatch: SandboxMount | undefined
  for (const mount of mounts) {
    if (hasPrefix(hostPath, mount.hostDir)) {
      if (!bestMatch || mount.hostDir.length > bestMatch.hostDir.length) {
        bestMatch = mount
      }
    }
  }

  if (bestMatch) {
    if (hostPath === bestMatch.hostDir) return bestMatch.containerDir
    return bestMatch.containerDir + hostPath.slice(bestMatch.hostDir.length)
  }

  return hostPath
}

export function isInsideAnyMount(p: string, mounts: SandboxMount[]): boolean {
  for (const mount of mounts) {
    if (hasPrefix(p, mount.hostDir) || hasPrefix(p, mount.containerDir)) {
      return true
    }
  }
  return false
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function rewriteOutput(output: string, mounts: SandboxMount[]): string {
  const sorted = [...mounts].sort((a, b) => b.containerDir.length - a.containerDir.length)
  if (sorted.length === 0) return output

  const patternParts = sorted.map(m => `(?<![A-Za-z0-9_/])(${escapeRegex(m.containerDir)}(?=/|$|[^A-Za-z0-9_-]))`)
  const combined = new RegExp(patternParts.join('|'), 'g')

  return output.replace(combined, (match) => {
    for (const mount of sorted) {
      if (match.startsWith(mount.containerDir)) {
        const suffix = match.slice(mount.containerDir.length)
        return mount.hostDir + suffix
      }
    }
    return match
  })
}
