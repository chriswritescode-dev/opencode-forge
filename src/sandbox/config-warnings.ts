import { z } from 'zod'

export interface LegacySandboxConfigInput {
  mode?: unknown
  projectMountPath?: unknown
  resources?: unknown
  network?: unknown
  mounts?: unknown
}

const legacySandboxConfigSchema = z.looseObject({
  mode: z.string().optional().catch(undefined),
  projectMountPath: z.unknown().optional(),
  resources: z.looseObject({
    shmSize: z.unknown().optional(),
    memorySwap: z.unknown().optional(),
  }).optional().catch(undefined),
  network: z.looseObject({
    hostGateway: z.unknown().optional(),
  }).optional().catch(undefined),
  mounts: z.array(z.looseObject({ container: z.unknown().optional() }).catch({})).optional().catch(undefined),
})

export function collectLegacySandboxConfigWarnings(rawSandbox: LegacySandboxConfigInput | undefined): string[] {
  const parsed = legacySandboxConfigSchema.safeParse(rawSandbox)
  if (!parsed.success) return []
  const sandboxConfig = parsed.data

  const warnings: string[] = []

  const mode = sandboxConfig.mode
  if (mode === 'docker') {
    warnings.push("sandbox.mode 'docker' is ignored: the msb migration replaces the Docker driver; use mode 'msb'")
  } else if (mode !== undefined && mode !== 'msb') {
    warnings.push(`sandbox.mode ${JSON.stringify(mode)} is replaced: the msb driver is the only supported sandbox mode; use mode 'msb'`)
  }
  if ('projectMountPath' in sandboxConfig) {
    warnings.push('sandbox.projectMountPath is ignored: msb mounts the source project read-only at its own host path')
  }

  const resources = sandboxConfig.resources
  if (resources) {
    if ('shmSize' in resources) {
      warnings.push('sandbox.resources.shmSize is ignored: msb does not support a shared-memory flag; remove it')
    }
    if ('memorySwap' in resources) {
      warnings.push('sandbox.resources.memorySwap is ignored: msb does not support a separate swap limit; remove it')
    }
  }

  const network = sandboxConfig.network
  if (network && 'hostGateway' in network) {
    warnings.push('sandbox.network.hostGateway is ignored: msb blocks host loopback — use sandbox.network.allow')
  }

  const mounts = sandboxConfig.mounts
  if (mounts?.some((mount) => 'container' in mount)) {
    warnings.push('sandbox.mounts[].container is ignored: msb mounts every workspace at its identical host path')
  }

  return warnings
}
