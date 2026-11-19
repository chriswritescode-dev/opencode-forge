import { z } from 'zod'
import type { SandboxConfig } from '../types'

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
    warnings.push("sandbox.mode 'docker' is ignored: the msb migration replaces the Docker driver; use mode 'msb' or 'macos'")
  } else if (mode !== undefined && mode !== 'msb' && mode !== 'macos') {
    warnings.push(`sandbox.mode ${JSON.stringify(mode)} is replaced: the supported sandbox modes are 'msb' and 'macos'; use mode 'msb' or 'macos'`)
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

export function collectMacosSandboxConfigWarnings(sandbox: SandboxConfig | undefined): string[] {
  if (sandbox?.mode !== 'macos') return []

  const warnings: string[] = []
  const resources = sandbox.resources
  if (resources?.dockerDisk !== undefined) {
    warnings.push('sandbox.resources.dockerDisk is ignored in the macOS sandbox mode: the shared macOS VM has no per-sandbox Docker disk')
  }
  if (resources?.cacheDisk !== undefined) {
    warnings.push('sandbox.resources.cacheDisk is ignored in the macOS sandbox mode: the shared macOS VM has no cache disk')
  }
  if (resources?.cpus !== undefined) {
    warnings.push('sandbox.resources.cpus is ignored in the macOS sandbox mode: the shared macOS VM is sized by its Lume configuration')
  }
  if (resources?.memory !== undefined) {
    warnings.push('sandbox.resources.memory is ignored in the macOS sandbox mode: the shared macOS VM is sized by its Lume configuration')
  }

  const network = sandbox.network
  if (network?.allowLan !== undefined) {
    warnings.push('sandbox.network.allowLan is ignored in the macOS sandbox mode: the shared macOS VM uses the host network gateway')
  }
  if (network?.env !== undefined) {
    warnings.push('sandbox.network.env is ignored in the macOS sandbox mode: the shared macOS VM starts with a fixed environment')
  }
  if (network?.secrets !== undefined) {
    warnings.push('sandbox.network.secrets is ignored in the macOS sandbox mode: per-loop secrets are not supported in the macOS sandbox mode')
  }

  return warnings
}
