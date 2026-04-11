const CONTAINER_WORKSPACE = '/workspace'

export function toContainerPath(hostPath: string, hostDir: string): string {
  if (hostPath.startsWith(hostDir)) {
    return hostPath.replace(hostDir, CONTAINER_WORKSPACE)
  }
  if (hostPath.startsWith(CONTAINER_WORKSPACE)) {
    return hostPath
  }
  return hostPath
}

export function toHostPath(containerPath: string, hostDir: string): string {
  if (containerPath.startsWith(CONTAINER_WORKSPACE)) {
    return containerPath.replace(CONTAINER_WORKSPACE, hostDir)
  }
  if (containerPath.startsWith('/')) {
    return containerPath
  }
  const absolutePath = `${CONTAINER_WORKSPACE}/${containerPath}`
  return absolutePath.replace(CONTAINER_WORKSPACE, hostDir)
}

export function rewriteOutput(output: string, hostDir: string): string {
  let result = output
  result = result.replace(new RegExp(`${CONTAINER_WORKSPACE}/`, 'g'), `${hostDir}/`)
  result = result.replace(new RegExp(`${CONTAINER_WORKSPACE}$`, 'gm'), hostDir)
  return result
}
