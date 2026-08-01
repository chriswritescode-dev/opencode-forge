import { isRecord } from '../utils/is-record'

/**
 * Return one message per legacy `sandbox` config key that sbx can no longer
 * express, so a stale `forge-config.jsonc` reports exactly which keys stopped
 * mattering. Operates on the raw parsed JSONC value because these keys no
 * longer exist on `SandboxConfig`. Non-object input returns an empty list.
 */
export function collectLegacySandboxConfigWarnings(rawSandbox: unknown): string[] {
  if (!isRecord(rawSandbox)) return []

  const warnings: string[] = []

  if (rawSandbox.mode === 'docker') {
    warnings.push("sandbox.mode 'docker' is ignored: the sbx migration replaces the Docker driver; use mode 'sbx'")
  }
  if ('projectMountPath' in rawSandbox) {
    warnings.push('sandbox.projectMountPath is ignored: sbx mounts the source project read-only at its own host path')
  }

  const resources = rawSandbox.resources
  if (isRecord(resources)) {
    if ('shmSize' in resources) {
      warnings.push('sandbox.resources.shmSize is ignored: sbx does not support a shared-memory flag; remove it')
    }
    if ('memorySwap' in resources) {
      warnings.push('sandbox.resources.memorySwap is ignored: sbx does not support a separate swap limit; remove it')
    }
  }

  const network = rawSandbox.network
  if (isRecord(network) && 'hostGateway' in network) {
    warnings.push('sandbox.network.hostGateway is ignored: sbx blocks host loopback — use sandbox.network.allow')
  }

  const mounts = rawSandbox.mounts
  if (Array.isArray(mounts) && mounts.some((m) => isRecord(m) && 'container' in m)) {
    warnings.push('sandbox.mounts[].container is ignored: sbx mounts every workspace at its identical host path')
  }

  return warnings
}
