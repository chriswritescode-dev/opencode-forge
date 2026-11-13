import type { Logger } from '../types'
import type { SandboxContext } from './context'
import { LRUCache } from '../utils/lru-cache'
import { runCommand } from './process'

export const ENV_PROBE_COMMAND =
  'uname -srm; if [ -r /etc/os-release ]; then . /etc/os-release; echo "$PRETTY_NAME"; elif command -v sw_vers >/dev/null 2>&1; then echo "macOS $(sw_vers -productVersion)"; fi'

const PROBE_TIMEOUT_MS = 10000
const PROBE_MAX_LENGTH = 200
const PROBE_CACHED_CONTAINER_LIMIT = 100

export function formatEnvironmentDescriptor(stdout: string): string | null {
  const parts = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  return parts.join(' | ').slice(0, PROBE_MAX_LENGTH)
}

export interface EnvironmentProbe {
  describeHost(): Promise<string | null>
  describeSandbox(sandbox: SandboxContext): Promise<string | null>
}

export function createEnvironmentProbe(logger: Logger): EnvironmentProbe {
  let hostProbe: Promise<string | null> | undefined
  const sandboxProbes = new LRUCache<Promise<string | null>>(PROBE_CACHED_CONTAINER_LIMIT)

  async function probeHost(): Promise<string | null> {
    try {
      const result = await runCommand('sh', ['-c', ENV_PROBE_COMMAND], {
        timeout: PROBE_TIMEOUT_MS,
        logger,
        logLabel: 'env-probe',
      })
      if (result.exitCode !== 0) return null
      return formatEnvironmentDescriptor(result.stdout)
    } catch (err) {
      logger.error('[env-probe] host probe failed', err)
      return null
    }
  }

  async function probeSandbox(sandbox: SandboxContext): Promise<string | null> {
    try {
      const result = await sandbox.runtime.exec(sandbox.containerName, ENV_PROBE_COMMAND, {
        timeout: PROBE_TIMEOUT_MS,
        cwd: sandbox.hostDir,
      })
      if (result.exitCode !== 0) return null
      return formatEnvironmentDescriptor(result.stdout)
    } catch (err) {
      logger.error(`[env-probe] container probe failed for ${sandbox.containerName}`, err)
      return null
    }
  }

  return {
    describeHost() {
      hostProbe ??= probeHost()
      return hostProbe
    },
    describeSandbox(sandbox) {
      const cached = sandboxProbes.get(sandbox.containerName)
      if (cached) return cached
      const pending = probeSandbox(sandbox)
      sandboxProbes.set(sandbox.containerName, pending)
      return pending
    },
  }
}
