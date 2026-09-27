import { createSignal, type Accessor } from 'solid-js'
import {
  FORGE_HOST_SANDBOX_DISABLED_ERROR,
  type ForgeHostSandboxSetOutput,
  type ForgeHostSandboxStateOutput,
  type ForgeToastInput,
} from '../host/forge-rpc'
import {
  awaitSessionSandboxState,
  deriveSandboxPollDelayMs,
  hostSandboxToggleBlocked,
  type SessionSandboxPreference,
} from './session-sandbox-store'

/** Delay between host sandbox polls while the server reports sandboxing disabled. */
const SANDBOX_HIDDEN_POLL_DELAY_MS = 5000

/** Keeps an awaiting toggle polling when the server reports sandboxing disabled mid-flight. */
const HIDDEN_PREFERENCE: SessionSandboxPreference = {
  desired: null,
  applied: null,
  unavailable: true,
  unavailableReason: FORGE_HOST_SANDBOX_DISABLED_ERROR,
}

export interface HostSandboxToggleDeps {
  readState(): Promise<ForgeHostSandboxStateOutput>
  setState(sessionId: string, enabled: boolean): Promise<ForgeHostSandboxSetOutput>
  currentSessionId(): string | null
  toast(input: ForgeToastInput): void
}

export interface HostSandboxToggle {
  /** Latest desired/applied preference pair, or null when sandboxing is disabled by config. */
  preference: Accessor<SessionSandboxPreference | null>
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

/**
 * The TUI side of the host session sandbox: reads the desired/applied pair for the
 * current session through the Forge server RPC and follows the server's
 * acknowledgement. The server reconciles the request and routes the session's shell,
 * glob, and grep calls into the sandbox.
 */
export function createHostSandboxToggle(deps: HostSandboxToggleDeps): HostSandboxToggle {
  const [preference, setPreference] = createSignal<SessionSandboxPreference | null>(null, { equals: preferencesEqual })
  const lifecycle = new AbortController()
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let waiter: AbortController | null = null

  const readState = async (): Promise<ForgeHostSandboxStateOutput> => {
    try {
      return await deps.readState()
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  const schedule = (delayMs: number): void => {
    if (lifecycle.signal.aborted) return
    pollTimer = setTimeout(() => {
      pollTimer = null
      void tick()
    }, delayMs)
  }

  const tick = async (): Promise<void> => {
    if (lifecycle.signal.aborted) return
    const next = preferenceFrom(await readState())
    if (lifecycle.signal.aborted) return
    setPreference(next)
    schedule(next ? deriveSandboxPollDelayMs(next) : SANDBOX_HIDDEN_POLL_DELAY_MS)
  }

  schedule(0)

  const toggle = async (): Promise<void> => {
    const sessionId = deps.currentSessionId()
    if (!sessionId) {
      deps.toast({ message: 'Open a session first', variant: 'info', duration: 3000 })
      return
    }
    const state = await readState()
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
    const request = new AbortController()
    waiter?.abort()
    waiter = request
    try {
      const result = await deps.setState(sessionId, enabling)
      if (lifecycle.signal.aborted) return
      if ('error' in result) {
        deps.toast({ message: `Sandbox toggle failed: ${result.error}`, variant: 'error', duration: 6000 })
        return
      }
      revision = result.revision
      setPreference(preferenceFrom(await readState()))
      const applied = await awaitSessionSandboxState(
        async () => preferenceFrom(await readState()) ?? HIDDEN_PREFERENCE,
        revision,
        { timeoutMs: 15_000, pollMs: 250, signal: AbortSignal.any([request.signal, lifecycle.signal]) },
      )
      const latest = preferenceFrom(await readState())
      if (latest?.desired?.revision !== applied.revision) return
      deps.toast({
        message: applied.enabled
          ? 'Host sandbox enabled for this session. Agent shell, glob, and grep calls run in the sandbox; commands you run yourself stay on the host.'
          : 'Host sandbox disabled for this session',
        variant: 'success',
        duration: 5000,
      })
    } catch (err) {
      if (lifecycle.signal.aborted) return
      const latest = preferenceFrom(await readState())
      if (latest?.desired && revision && latest.desired.revision !== revision) return
      const message = err instanceof Error ? err.message : String(err)
      const guidance = enabling ? 'Toggle off, then on to retry.' : 'Toggle again to retry disabling.'
      deps.toast({ message: `Sandbox toggle failed: ${message}. ${guidance}`, variant: 'error', duration: 6000 })
    } finally {
      if (waiter === request) waiter = null
    }
  }

  return {
    preference,
    toggle,
    dispose() {
      lifecycle.abort()
      waiter?.abort()
      if (pollTimer) clearTimeout(pollTimer)
      pollTimer = null
    },
  }
}
