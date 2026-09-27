import type { ForgeTuiEvent } from './forge-rpc'
import { processShared } from '../utils/process-shared'

/** Publishes one host-neutral TUI event; the registry guarantees it never throws into the caller. */
export type ForgeTuiEventEmitter = (event: ForgeTuiEvent) => void

/**
 * Live emitters per project for the whole process. The host sandbox controller is
 * process-shared and can outlive the instance that created it, so a change callback
 * cannot capture its creator's emitter; it resolves a live one here instead.
 */
const sharedTuiEventEmitters = processShared(
  'tui-event-emitters.v1',
  () => new Map<string, Set<ForgeTuiEventEmitter>>(),
)

/** Registers `emit` as a live TUI emitter for `projectId`; returns the deregistration. */
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

/**
 * Publishes `event` through one live TUI emitter for `projectId`. The TUI filters by
 * projectId, so a single emitter suffices; with no live emitter the event is dropped.
 */
export function emitTuiEvent(projectId: string, event: ForgeTuiEvent): void {
  const emit = sharedTuiEventEmitters.get(projectId)?.values().next().value
  if (!emit) return
  try {
    emit(event)
  } catch (err) {
    console.error('[forge] failed to publish TUI event', err)
  }
}
