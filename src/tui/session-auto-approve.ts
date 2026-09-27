import { createSignal, type Accessor } from 'solid-js'
import type { ForgeAutoApproveState, ForgeToastInput } from '../host/forge-rpc'
import { SESSION_AUTO_APPROVE_TTL_MS } from '../storage/repos/session-auto-approve-repo'
import { createRefetchCoordinator } from './refetch-coordinator'

const TTL_DAYS = Math.round(SESSION_AUTO_APPROVE_TTL_MS / (24 * 60 * 60 * 1000))

const ENABLED_MESSAGE =
  `Auto-approve enabled for this session and its subagents. Nothing will prompt: ask rules and autoApprove.deny rules are denied, everything else is allowed. Expires after ${TTL_DAYS} days idle.`

export interface SessionAutoApproveToggleDeps {
  currentSessionId(): string | null
  readState(sessionId: string): Promise<ForgeAutoApproveState>
  setState(sessionId: string, enabled: boolean): Promise<ForgeAutoApproveState>
  isSandboxedSession(sessionId: string): boolean
  toast(input: ForgeToastInput): void
}

export interface SessionAutoApproveToggle {
  /** Whether auto-approve is on for the session currently on the route. */
  enabled: Accessor<boolean>
  /** Re-read the flag for the current route; coalesced with any in-flight read. */
  refresh(): void
  toggle(): Promise<void>
  dispose(): void
}

/**
 * The TUI side of per-session auto-approve: reads and writes the effective flag for
 * the session on the current route through the Forge server RPC, so the TUI works
 * against a remote server without opening the Forge database. It reads once at startup
 * and on every `autoApproveChanged` push or open-session change. The server resolves
 * every prompt for the session and its subagents to allow or deny without prompting.
 */
export function createSessionAutoApproveToggle(deps: SessionAutoApproveToggleDeps): SessionAutoApproveToggle {
  const [enabled, setEnabled] = createSignal(false)
  const lifecycle = new AbortController()

  const refresh = async (): Promise<void> => {
    const sessionId = deps.currentSessionId()
    if (!sessionId) {
      setEnabled(false)
      return
    }
    const state = await deps.readState(sessionId)
    const next = 'error' in state ? false : state.enabled
    if (lifecycle.signal.aborted) return
    if (deps.currentSessionId() !== sessionId) return
    setEnabled(next)
  }

  const coordinator = createRefetchCoordinator(refresh)
  coordinator.trigger()

  const toggle = async (): Promise<void> => {
    const sessionId = deps.currentSessionId()
    if (!sessionId) {
      deps.toast({ message: 'Open a session first', variant: 'info', duration: 3000 })
      return
    }
    const state = await deps.readState(sessionId)
    if (lifecycle.signal.aborted || deps.currentSessionId() !== sessionId) return
    if ('error' in state) {
      deps.toast({ message: `Auto-approve unavailable: ${state.error}`, variant: 'warning', duration: 5000 })
      return
    }
    const next = !state.enabled
    const result = await deps.setState(sessionId, next)
    if ('error' in result) {
      deps.toast({ message: result.error, variant: 'warning', duration: 5000 })
      return
    }
    if (deps.currentSessionId() === sessionId) setEnabled(result.enabled)
    if (!result.enabled) {
      deps.toast({ message: 'Auto-approve disabled for this session', variant: 'success', duration: 5000 })
      return
    }
    const sandboxed = deps.isSandboxedSession(sessionId)
    deps.toast({
      message: sandboxed ? ENABLED_MESSAGE : `${ENABLED_MESSAGE} Host sandbox is off: approved commands run directly on your machine.`,
      variant: sandboxed ? 'success' : 'warning',
      duration: 5000,
    })
  }

  return {
    enabled,
    refresh: coordinator.trigger,
    toggle,
    dispose() {
      lifecycle.abort()
      coordinator.dispose()
    },
  }
}
