import { describe, test, expect, vi } from 'vitest'
import type { Loop } from '../../src/loop/runtime'
import type { LoopService } from '../../src/loop/service'
import type { ForgeClient } from '../../src/client/port'
import type { Logger, PluginConfig } from '../../src/types'

const logger: Logger = { log: () => {}, error: () => {}, debug: () => {} }

function createFakeClient(): ForgeClient {
  return new Proxy({}, { get: () => () => Promise.resolve(undefined) }) as unknown as ForgeClient
}

function createFakeLoopService(): LoopService {
  return new Proxy({}, { get: () => () => undefined }) as unknown as LoopService
}

type CreateLoop = (deps: Parameters<typeof import('../../src/loop/runtime').createLoop>[0]) => Loop

function buildLoop(createLoop: CreateLoop, projectId: string): Loop {
  return createLoop({
    loopsRepo: {} as never,
    plansRepo: {} as never,
    reviewFindingsRepo: {} as never,
    projectId,
    client: createFakeClient(),
    logger,
    getConfig: () => ({}) as PluginConfig,
    loopService: createFakeLoopService(),
  })
}

/**
 * Each call returns a distinct module copy of the runtime, mirroring OpenCode's
 * per-location module graph. The process-shared state those copies use lives on
 * globalThis, so both copies resolve the same lock map.
 */
async function importRuntimeCopy(): Promise<CreateLoop> {
  vi.resetModules()
  const mod = await import('../../src/loop/runtime')
  return mod.createLoop as CreateLoop
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

describe('Loop runtime process-shared state locks', () => {
  test('two module copies with the same project serialize runExclusive on the same loop name', async () => {
    const createLoopA = await importRuntimeCopy()
    const createLoopB = await importRuntimeCopy()
    const loopA = buildLoop(createLoopA, 'shared-project')
    const loopB = buildLoop(createLoopB, 'shared-project')

    const gate = deferred()
    let firstStarted = false
    const first = loopA.runExclusive('shared-loop', async () => {
      firstStarted = true
      await gate.promise
      return 'first'
    })

    await flush()
    expect(firstStarted).toBe(true)

    let secondStarted = false
    const second = loopB.runExclusive('shared-loop', async () => {
      secondStarted = true
      return 'second'
    })

    await flush()
    expect(secondStarted).toBe(false)

    gate.resolve()
    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('second')
    expect(secondStarted).toBe(true)
  })

  test('two module copies with different projects do not block each other on the same loop name', async () => {
    const createLoopA = await importRuntimeCopy()
    const createLoopB = await importRuntimeCopy()
    const loopA = buildLoop(createLoopA, 'project-a')
    const loopB = buildLoop(createLoopB, 'project-b')

    const gate = deferred()
    let firstStarted = false
    const first = loopA.runExclusive('same-name-loop', async () => {
      firstStarted = true
      await gate.promise
      return 'first'
    })

    await flush()
    expect(firstStarted).toBe(true)

    let secondStarted = false
    const second = loopB.runExclusive('same-name-loop', async () => {
      secondStarted = true
      return 'second'
    })

    await flush()
    expect(secondStarted).toBe(true)

    gate.resolve()
    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('second')
  })
})
