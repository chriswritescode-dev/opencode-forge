import { describe, test, expect, beforeEach } from 'vitest'
import { emitTuiEvent, registerTuiEventEmitter } from '../../src/host/tui-events'
import type { ForgeTuiEvent } from '../../src/host/forge-rpc'

describe('tui event emitter registry', () => {
  const projectId = `proj-tui-events-${Date.now()}`

  beforeEach(() => {
    // Registry state is process-shared; each test uses a unique project id so
    // registrations from another test can never leak in.
  })

  test('emits through a live emitter for the project', () => {
    const events: ForgeTuiEvent[] = []
    const unregister = registerTuiEventEmitter(projectId, (event) => events.push(event))
    try {
      emitTuiEvent(projectId, { type: 'loopsChanged', projectId })
      expect(events).toEqual([{ type: 'loopsChanged', projectId }])
    } finally {
      unregister()
    }
  })

  test('drops the event when no emitter is registered for the project', () => {
    expect(() => emitTuiEvent(projectId, { type: 'loopsChanged', projectId })).not.toThrow()
  })

  test('drops the project entry once the last emitter unregisters', () => {
    const first = registerTuiEventEmitter(projectId, () => {})
    const second = registerTuiEventEmitter(projectId, () => {})
    first()
    const events: ForgeTuiEvent[] = []
    const third = registerTuiEventEmitter(projectId, (event) => events.push(event))
    second()
    third()
    emitTuiEvent(projectId, { type: 'hostSandboxChanged', projectId })
    expect(events).toEqual([])
  })

  test('emits through a surviving emitter after the creating instance is disposed', () => {
    const disposedInstanceEvents: ForgeTuiEvent[] = []
    const survivingInstanceEvents: ForgeTuiEvent[] = []
    const unregisterDisposed = registerTuiEventEmitter(projectId, (event) => disposedInstanceEvents.push(event))
    const unregisterSurviving = registerTuiEventEmitter(projectId, (event) => survivingInstanceEvents.push(event))

    // The controller created by the first instance outlives it; its change callback
    // resolves a live emitter at call time, not the creator's.
    unregisterDisposed()
    emitTuiEvent(projectId, { type: 'hostSandboxChanged', projectId })

    expect(survivingInstanceEvents).toEqual([{ type: 'hostSandboxChanged', projectId }])
    expect(disposedInstanceEvents).toEqual([])
    unregisterSurviving()
  })

  test('swallows a throwing emitter instead of propagating into the caller', () => {
    const unregister = registerTuiEventEmitter(projectId, () => {
      throw new Error('emitter exploded')
    })
    try {
      expect(() => emitTuiEvent(projectId, { type: 'autoApproveChanged', projectId, sessionId: 'ses_1' })).not.toThrow()
    } finally {
      unregister()
    }
  })
})
