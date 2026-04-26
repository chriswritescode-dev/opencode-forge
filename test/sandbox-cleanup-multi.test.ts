import { beforeEach, describe, expect, test } from 'bun:test'
import { cleanupSandboxOrphansAcrossRegistry } from '../src/index'
import { getProjectRegistry } from '../src/api/project-registry'
import type { ToolContext } from '../src/tools/types'

function makeCtx(
  projectId: string,
  directory: string,
  loopNames: string[]
): ToolContext {
  return {
    projectId,
    directory,
    loopService: {
      listActive: () =>
        loopNames.map((loopName) => ({
          loopName,
          sandbox: true,
        })),
    },
  } as unknown as ToolContext
}

describe('sandbox orphan cleanup across project registry', () => {
  beforeEach(() => {
    const registry = getProjectRegistry()
    for (const ctx of registry.list()) {
      registry.unregister(ctx.projectId)
    }
  })

  test('passes preserve loop union from all registered projects', async () => {
    const registry = getProjectRegistry()
    registry.register(makeCtx('project-a', '/path/A', ['loop-a-1', 'loop-a-2']))
    registry.register(makeCtx('project-b', '/path/B', ['loop-b-1']))

    let received: string[] = []
    const sandboxManager = {
      cleanupOrphans: async (preserve?: string[]) => {
        received = preserve ?? []
        return 0
      },
    }

    const preserveLoops = await cleanupSandboxOrphansAcrossRegistry(
      registry,
      sandboxManager
    )

    expect(preserveLoops.sort()).toEqual(['loop-a-1', 'loop-a-2', 'loop-b-1'])
    expect(received.sort()).toEqual(['loop-a-1', 'loop-a-2', 'loop-b-1'])
  })
})
