const CONTAINER_WORKSPACE = '/workspace'

function hasPrefix(path: string, prefix: string): boolean {
  if (path === prefix) return true
  return path.startsWith(prefix + '/')
}

export function toContainerPath(hostPath: string, hostDir: string): string {
  if (hasPrefix(hostPath, hostDir)) {
    if (hostPath === hostDir) return CONTAINER_WORKSPACE
    return CONTAINER_WORKSPACE + hostPath.slice(hostDir.length)
  }
  if (hasPrefix(hostPath, CONTAINER_WORKSPACE)) {
    return hostPath
  }
  return hostPath
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function rewriteOutput(output: string, hostDir: string): string {
  const escaped = escapeRegex(CONTAINER_WORKSPACE)
  // Match /workspace as a whole path token: either followed by a path separator,
  // or by a non-path character (end-of-string, whitespace, punctuation), so
  // /workspace-foo and /workspaces are preserved but /workspace, /workspace/x,
  // '/workspace', "/workspace:", and /workspace) are all rewritten.
  const pattern = new RegExp(`${escaped}(?=/|$|[^A-Za-z0-9_-])`, 'g')
  return output.replace(pattern, hostDir)
}
