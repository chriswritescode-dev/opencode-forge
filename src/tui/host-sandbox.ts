import { createSignal, type Accessor } from 'solid-js'
import {
  type ForgeHostSandboxSetOutput,
  type ForgeHostSandboxStateOutput,
  type ForgeRpcError,
  type ForgeToastInput,
} from '../host/forge-rpc'
import {
  hostSandboxToggleBlocked,
  type SessionSandboxPreference,
} from './session-sandbox-store'
import { createRefetchCoordinator } from './refetch-coordinator'
import { errorMessage } from '../utils/error-message'
import type { SessionSandboxAppliedState } from '../storage/repos/session-sandbox-preferences-repo'

export interface HostSandboxToggleDeps {
  readState(): Promise<ForgeHostSandboxStateOutput>
  setState(sessionId: string, enabled: boolean): Promise<ForgeHostSandboxSetOutput>
  currentSessionId(): string | null
  toast(input: ForgeToastInput): void
}

export interface HostSandboxToggle {
  /** Latest desired/applied preference pair, or null when sandboxing is disabled by config. */
  preference: Accessor<SessionSandboxPreference | null>
  /** Re-read the current state; coalesced with any in-flight read. */
  refresh(): void
  toggle(): Promise<void>
  dispose(): void
}

function preferencesEqual(a: SessionSandboxPreference | null, b: SessionSandboxPreference | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return JSON.stringify([a.desired, a.applied, a.controller, a.activeLoopSandboxes])
    === JSON.stringify([b.desired, b.applied, b.controller, b.activeLoopSandboxes])
}

/**
 * Maps the server's host sandbox state to the TUI preference shape. A config-disabled
 * server returns null so the sidebar hides the indicator; a read error becomes an
 * unavailable preference so the toggle refuses with the reason.
 */
function preferenceFrom(state: ForgeRpcError): SessionSandboxPreference
function preferenceFrom(state: ForgeHostSandboxStateOutput): SessionSandboxPreference | null
function preferenceFrom(state: ForgeHostSandboxStateOutput): SessionSandboxPreference | null {
  if ('error' in state) {
    return { desired: null, applied: null, unavailable: true, unavailableReason: state.error }
  }
  if (!state.configEnabled) return null
  return {
    desired: state.desired,
    applied: state.applied,
    controller: state.controller,
    ...(state.activeLoopSandboxes ? { activeLoopSandboxes: state.activeLoopSandboxes } : {}),
  }
}

interface SandboxWaiter {
  revision: string
  cancelled: boolean
  resolve(applied: SessionSandboxAppliedState): void
  reject(error: Error): void
  cancel(): void
}

function createSandboxWaiter(
  revision: string,
  options: { timeoutMs: number; signal: AbortSignal },
): { waiter: SandboxWaiter; promise: Promise<SessionSandboxAppliedState> } {
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

/**
 * The TUI side of the host session sandbox: reads the desired/applied pair for the
 * current session through the Forge server RPC and follows the server's push events.
 * A toggle registers a deadline waiter, triggers a refetch, and resolves when an
 * event-triggered refetch reports the matching applied revision.
 */
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
      if (applied.error !== null) current.reject(new Error(applied.error))
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

  const toggle = async (): Promise<void> => {
    const sessionId = deps.currentSessionId()
    if (!sessionId) {
      deps.toast({ message: 'Open a session first', variant: 'info', duration: 3000 })
      return
    }
    const state = await deps.readState()
    if (lifecycle.signal.aborted) return
    if ('error' in state) {
      setPreference(preferenceFrom(state))
      deps.toast({ message: `Sandbox toggle unavailable: ${state.error}`, variant: 'warning', duration: 5000 })
      return
    }
    const blocked = hostSandboxToggleBlocked(state.configEnabled)
    if (blocked) {
      deps.toast({ message: blocked, variant: 'warning', duration: 5000 })
      return
    }
    const current = preferenceFrom(state)
    if (!current) return
    const enabling = !(current.desired?.enabled === true && current.desired.sessionId === sessionId)
    let revision: string | null = null
    let pending: SandboxWaiter | null = null
    waiter?.cancel()
    waiter = null
    try {
      const result = await deps.setState(sessionId, enabling)
      if (lifecycle.signal.aborted) return
      if ('error' in result) {
        deps.toast({ message: `Sandbox toggle failed: ${result.error}`, variant: 'error', duration: 6000 })
        return
      }
      revision = result.revision
      const created = createSandboxWaiter(revision, { timeoutMs: 15_000, signal: lifecycle.signal })
      pending = created.waiter
      waiter = created.waiter
      coordinator.trigger()
      const applied = await created.promise
      const latest = preference()
      if (latest?.desired?.revision !== applied.revision) return
      deps.toast({
        message: applied.enabled
          ? 'Host sandbox enabled for this session. Agent shell, glob, and grep calls run in the sandbox; commands you run yourself stay on the host.'
          : 'Host sandbox disabled for this session',
        variant: 'success',
        duration: 5000,
      })
    } catch (err) {
      if (lifecycle.signal.aborted || pending?.cancelled) return
      const latest = preference()
      if (latest?.desired && revision && latest.desired.revision !== revision) return
      const guidance = enabling ? 'Toggle off, then on to retry.' : 'Toggle again to retry disabling.'
      deps.toast({ message: `Sandbox toggle failed: ${errorMessage(err)}. ${guidance}`, variant: 'error', duration: 6000 })
    } finally {
      if (waiter === pending) waiter = null
    }
  }

  return {
    preference,
    refresh: coordinator.trigger,
    toggle,
    dispose() {
      lifecycle.abort()
      waiter?.cancel()
      coordinator.dispose()
    },
  }
}
