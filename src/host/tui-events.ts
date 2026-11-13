import type { ForgeTuiEvent } from './forge-rpc'
import { processShared } from '../utils/process-shared'

export type ForgeTuiEventEmitter = (event: ForgeTuiEvent) => void

const sharedTuiEventEmitters = processShared(
  'tui-event-emitters.v1',
  () => new Map<string, Set<ForgeTuiEventEmitter>>(),
)

export function registerTuiEventEmitter(projectId: string, emit: ForgeTuiEventEmitter): () => void {
  let emitters = sharedTuiEventEmitters.get(projectId)
  if (!emitters) {
    emitters = new Set()
    sharedTuiEventEmitters.set(projectId, emitters)
  }
  emitters.add(emit)
  return () => {
    emitters.delete(emit)
    if (emitters.size === 0) sharedTuiEventEmitters.delete(projectId)
  }
}

export function emitTuiEvent(projectId: string, event: ForgeTuiEvent): void {
  const emit = sharedTuiEventEmitters.get(projectId)?.values().next().value
  if (!emit) return
  try {
    emit(event)
  } catch (err) {
    console.error('[forge] failed to publish TUI event', err)
  }
}
