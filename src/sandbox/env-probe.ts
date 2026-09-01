import type { Logger } from '../types'
import type { SandboxContext } from './context'
import { LRUCache } from '../utils/lru-cache'
import { runCommand } from './process'

/**
 * The single probe command, run verbatim on both the host and inside the container so the two
 * descriptors are directly comparable — that comparability is the whole point of reporting a
 * before/after pair. POSIX `sh` only: `msb exec` and the host runner both invoke `sh -c`.
 *
 * Line 1 is `uname -srm` (kernel, release, machine). Line 2 is the distribution label, which the
 * agent needs to pick a package manager when the note tells it to install missing tooling.
 */
export const ENV_PROBE_COMMAND =
  'uname -srm; if [ -r /etc/os-release ]; then . /etc/os-release; echo "$PRETTY_NAME"; elif command -v sw_vers >/dev/null 2>&1; then echo "macOS $(sw_vers -productVersion)"; fi'

const PROBE_TIMEOUT_MS = 10000
const PROBE_MAX_LENGTH = 200
const PROBE_CACHED_CONTAINER_LIMIT = 100

/** Collapses the probe's stdout into one bounded single-line descriptor. */
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

/**
 * Resolves human-readable descriptors for the host and for a container, used to tell the agent
 * exactly which environment it left and which one it is now in.
 *
 * Every outcome is cached permanently per environment, failures included. The system-prompt
 * transform runs before every LLM request, so an uncached probe would spawn a process per
 * request; a negative result is cached for the same reason, capping the cost at one probe per
 * environment. Ceiling: a container whose first probe fails never reports a descriptor for its
 * lifetime, and the note degrades to its environment-agnostic text.
 */
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
