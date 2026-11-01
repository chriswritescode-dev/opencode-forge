import { describe, test, expect, vi } from 'vitest'
import { createLoopChangeNotifier } from '../../src/host/forge-core'
import { createMockLogger } from '../helpers/logger'

function createHarness() {
  const publishLoopsChanged = vi.fn()
  const notify = createLoopChangeNotifier({
    directory: '/tmp/project',
    projectId: 'test-project',
    publishLoopsChanged,
    logger: createMockLogger(),
  })

  return { notify, publishLoopsChanged }
}

describe('createLoopChangeNotifier', () => {
  test('publishes a settled loop exactly once and never throws', () => {
    const { notify, publishLoopsChanged } = createHarness()

    expect(() => notify('settled', 'some-loop', { projectDir: '/tmp/project' })).not.toThrow()

    expect(publishLoopsChanged).toHaveBeenCalledTimes(1)
  })

  test('publishes for terminate and insert too', () => {
    const { notify, publishLoopsChanged } = createHarness()

    notify('terminate', 'some-loop')
    notify('insert', 'some-loop')

    expect(publishLoopsChanged).toHaveBeenCalledTimes(2)
  })
})
