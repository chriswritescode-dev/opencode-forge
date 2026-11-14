import { createSignal, type Accessor } from 'solid-js'
import {
  type ForgeHostSandboxSetInput,
  type ForgeHostSandboxSetOutput,
  type ForgeHostSandboxStateOutput,
  type ForgeRpcError,
  type ForgeToastInput,
} from '../host/forge-rpc'
import {
  hostSandboxToggleBlocked,
  isSessionSandboxWanted,
  type SessionSandboxPreference,
} from './session-sandbox-store'
import { createRefetchCoordinator } from './refetch-coordinator'
import { errorMessage } from '../utils/error-message'
import type { SessionSandboxAppliedState } from '../storage/repos/session-sandbox-preferences-repo'
import type { SandboxOverrides } from '../types'

export interface HostSandboxToggleDeps {
  readState(): Promise<ForgeHostSandboxStateOutput>
  setState(input: ForgeHostSandboxSetInput): Promise<ForgeHostSandboxSetOutput>
  currentSessionId(): string | null
  getParentSessionId?(sessionId: string): string | null | undefined
  toast(input: ForgeToastInput): void
}

export interface HostSandboxToggle {
  preference: Accessor<SessionSandboxPreference | null>
  refresh(): void
  toggle(): Promise<void>
  setOverrides(overrides: SandboxOverrides): Promise<void>
  dispose(): void
}

const TOGGLE_ACK_TIMEOUT_MS = 15_000
const OVERRIDES_ACK_TIMEOUT_MS = 120_000

function preferencesEqual(a: SessionSandboxPreference | null, b: SessionSandboxPreference | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return JSON.stringify([a.desired, a.applied, a.controller, a.activeLoopSandboxes, a.hostSessionsDefault])
    === JSON.stringify([b.desired, b.applied, b.controller, b.activeLoopSandboxes, b.hostSessionsDefault])
}

function preferenceFrom(state: ForgeRpcError): SessionSandboxPreference
function preferenceFrom(state: ForgeHostSandboxStateOutput): SessionSandboxPreference | null
function preferenceFrom(state: ForgeHostSandboxStateOutput): SessionSandboxPreference | null {
  if ('error' in state) {
    return { desired: null, applied: null, hostSessionsDefault: true, unavailable: true, unavailableReason: state.error }
  }
  if (!state.configEnabled) return null
  const preference: SessionSandboxPreference = {
    desired: state.desired,
    applied: state.applied,
    controller: state.controller,
    hostSessionsDefault: state.hostSessionsDefault,
  }
  if (state.activeLoopSandboxes) preference.activeLoopSandboxes = state.activeLoopSandboxes
  return preference
}

interface SandboxWaiter {
  revision: string
  tolerateAppliedError: boolean
  cancelled: boolean
  resolve(applied: SessionSandboxAppliedState): void
  reject(error: Error): void
  cancel(): void
}

interface SandboxWaiterHandle {
  waiter: SandboxWaiter
  promise: Promise<SessionSandboxAppliedState>
}

function createSandboxWaiter(
  revision: string,
  options: { timeoutMs: number; signal: AbortSignal; tolerateAppliedError?: boolean },
): SandboxWaiterHandle {
  let settled = false
  let resolvePromise: (applied: SessionSandboxAppliedState) => void = () => {}
  let rejectPromise: (error: Error) => void = () => {}
  const promise = new Promise<SessionSandboxAppliedState>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  const finish = (outcome: SessionSandboxAppliedState | Error): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    options.signal.removeEventListener('abort', onAbort)
    if (outcome instanceof Error) rejectPromise(outcome)
    else resolvePromise(outcome)
  }
  const onAbort = (): void => finish(new Error('Sandbox state request cancelled'))
  const timer = setTimeout(
    () => finish(new Error(`Timed out waiting for sandbox acknowledgement after ${options.timeoutMs}ms`)),
    options.timeoutMs,
  )
  if (options.signal.aborted) onAbort()
  else options.signal.addEventListener('abort', onAbort, { once: true })
  const waiter: SandboxWaiter = {
    revision,
    tolerateAppliedError: options.tolerateAppliedError === true,
    cancelled: false,
    resolve: (applied) => finish(applied),
    reject: (error) => finish(error),
    cancel: () => {
      waiter.cancelled = true
      finish(new Error('Sandbox state request cancelled'))
    },
  }
  return { promise, waiter }
}

export function createHostSandboxToggle(deps: HostSandboxToggleDeps): HostSandboxToggle {
  const [preference, setPreference] = createSignal<SessionSandboxPreference | null>(null, { equals: preferencesEqual })
  const lifecycle = new AbortController()
  let waiter: SandboxWaiter | null = null

  const settleWaiter = (next: SessionSandboxPreference | null): void => {
    const current = waiter
    if (!current) return
    const applied = next?.applied
    if (applied && applied.revision === current.revision) {
      waiter = null
      if (applied.error !== null && !current.tolerateAppliedError) current.reject(new Error(applied.error))
      else current.resolve(applied)
      return
    }
    const controller = next?.controller
    if (controller?.revision === current.revision && controller.phase === 'failed') {
      waiter = null
      current.reject(new Error('Sandbox failed to apply the requested state'))
    }
  }

  const refresh = async (): Promise<void> => {
    const next = preferenceFrom(await deps.readState())
    if (lifecycle.signal.aborted) return
    setPreference(next)
    settleWaiter(next)
  }

  const coordinator = createRefetchCoordinator(refresh)
  coordinator.trigger()

  const loadedPreference = (): SessionSandboxPreference | null => {
    const loaded = preference()
    return loaded && loaded.unavailable !== true ? loaded : null
  }

  interface HostSandboxRequest {
    build(current: SessionSandboxPreference, sessionId: string): Omit<ForgeHostSandboxSetInput, 'sessionId'> | null
    label: string
    timeoutMs: number
    success(applied: SessionSandboxAppliedState): string
    guidance(): string
    tolerateAppliedError?(): boolean
  }

  const request = async (spec: HostSandboxRequest): Promise<void> => {
    const sessionId = deps.currentSessionId()
    if (!sessionId) {
      deps.toast({ message: 'Open a session first', variant: 'info', duration: 3000 })
      return
    }
    let current = loadedPreference()
    if (!current) {
      const state = await deps.readState()
      if (lifecycle.signal.aborted) return
      if ('error' in state) {
        setPreference(preferenceFrom(state))
        deps.toast({ message: `${spec.label} unavailable: ${state.error}`, variant: 'warning', duration: 5000 })
        return
      }
      const blocked = hostSandboxToggleBlocked(state.configEnabled)
      if (blocked) {
        deps.toast({ message: blocked, variant: 'warning', duration: 5000 })
        return
      }
      current = preferenceFrom(state)
    }
    if (!current) return
    const change = spec.build(current, sessionId)
    if (!change) return
    let revision: string | null = null
    let pending: SandboxWaiter | null = null
    waiter?.cancel()
    waiter = null
    try {
      const result = await deps.setState({ sessionId, ...change })
      if (lifecycle.signal.aborted) return
      if ('error' in result) {
        deps.toast({ message: `${spec.label} failed: ${result.error}`, variant: 'error', duration: 6000 })
        return
      }
      revision = result.revision
      const created = createSandboxWaiter(revision, {
        timeoutMs: spec.timeoutMs,
        signal: lifecycle.signal,
        tolerateAppliedError: spec.tolerateAppliedError?.() === true,
      })
      pending = created.waiter
      waiter = created.waiter
      coordinator.trigger()
      const applied = await created.promise
      const latest = preference()
      if (latest?.desired?.revision !== applied.revision) return
      deps.toast({ message: spec.success(applied), variant: 'success', duration: 5000 })
    } catch (err) {
      if (lifecycle.signal.aborted || pending?.cancelled) return
      const latest = preference()
      if (latest?.desired && revision && latest.desired.revision !== revision) return
      deps.toast({ message: `${spec.label} failed: ${errorMessage(err)}. ${spec.guidance()}`, variant: 'error', duration: 6000 })
    } finally {
      if (waiter === pending) waiter = null
    }
  }

  const toggle = async (): Promise<void> => {
    let enabling = true
    await request({
      label: 'Sandbox toggle',
      timeoutMs: TOGGLE_ACK_TIMEOUT_MS,
      build: (current, sessionId) => {
        enabling = !isSessionSandboxWanted(current, sessionId, deps.getParentSessionId)
        return { enabled: enabling }
      },
      success: () => enabling
        ? 'Sandbox on for this session. Agent shell, glob, and grep calls run in the project\'s shared sandbox; commands you run yourself stay on the host.'
        : 'Sandbox off for this session; its agent shell, glob, and grep calls run on the host. Other sessions keep the shared sandbox.',
      guidance: () => enabling ? 'Toggle off, then on to retry.' : 'Toggle again to retry disabling.',
      tolerateAppliedError: () => !enabling,
    })
  }

  const setOverrides = (overrides: SandboxOverrides): Promise<void> => request({
    label: 'Sandbox settings',
    timeoutMs: OVERRIDES_ACK_TIMEOUT_MS,
    build: () => ({ overrides }),
    success: (applied) => applied.running
      ? 'Shared sandbox settings applied'
      : 'Sandbox settings saved; they apply when the shared sandbox next starts',
    guidance: () => 'Change the setting again to retry.',
  })

  return {
    preference,
    refresh: coordinator.trigger,
    toggle,
    setOverrides,
    dispose() {
      lifecycle.abort()
      waiter?.cancel()
      coordinator.dispose()
    },
  }
}
