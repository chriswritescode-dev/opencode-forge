import type { SandboxManager } from './manager'
import type { Loop } from '../loop'
import type { Logger } from '../types'
import { loopRegistry } from '../utils/loop-registry'

export interface ReconcileSandboxesDeps {
  sandboxManager: SandboxManager
  loop: Loop
  logger: Logger
  projectId: string
}

const inFlightByDeps = new WeakMap<ReconcileSandboxesDeps, boolean>()

export async function reconcileSandboxes(deps: ReconcileSandboxesDeps): Promise<void> {
  const { sandboxManager, loop, logger, projectId } = deps

  if (inFlightByDeps.get(deps)) {
    return
  }

  inFlightByDeps.set(deps, true)

  try {
    const activeLoops = loop.listActive()
    const registeredLoops = loopRegistry.getAll(projectId)

    for (const state of activeLoops) {
      if (!registeredLoops.includes(state.loopName)) {
        continue
      }
      if (state.sandbox !== true || !state.worktreeDir || !state.loopName) {
        continue
      }

      try {
        const loopName = state.loopName

        if (sandboxManager.isActive(loopName)) {
          const isActuallyRunning = await sandboxManager.isLive(loopName)
          if (!isActuallyRunning) {
            logger.log(`Sandbox reconcile: map entry for ${loopName} was stale (container not in Docker)`)
          } else {
            const active = sandboxManager.getActive(loopName)
            if (active && state.sandboxContainer !== active.containerName) {
              loop.service.setSandboxContainer(loopName, active.containerName)
              const action = state.sandboxContainer ? 'corrected' : 'backfilled'
              logger.log(`Sandbox reconcile: ${action} container name for ${loopName}`)
            }
            continue
          }
        }

        if (state.sandboxContainer && state.sandboxContainer.length > 0) {
          await sandboxManager.restore(loopName, state.worktreeDir, state.startedAt)
          logger.log(`Sandbox reconcile: restored container for ${loopName}`)
          continue
        }

        const result = await sandboxManager.start(loopName, state.worktreeDir, state.startedAt)
        loop.service.setSandboxContainer(loopName, result.containerName)
        logger.log(`Sandbox reconcile: started container for ${loopName}`)
      } catch (err) {
        logger.error(`Sandbox reconcile: failed for ${state.loopName}`, err)
      }
    }
  } finally {
    inFlightByDeps.set(deps, false)
  }
}
