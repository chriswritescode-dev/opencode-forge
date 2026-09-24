import { existsSync } from 'fs'
import { createSignal, type Accessor } from 'solid-js'
import type { ForgeToastInput } from '../host/forge-rpc'
import { isSandboxConfigEnabled } from '../sandbox/context'
import type { PluginConfig } from '../types'
import {
  awaitSessionSandboxState,
  beginSessionSandboxStateRequest,
  deriveSandboxPollDelayMs,
  hostSandboxToggleBlocked,
  readSessionSandboxPreference,
  type SessionSandboxPreference,
} from './session-sandbox-store'

export interface HostSandboxToggleDeps {
  pluginConfig: PluginConfig
  dbPath: string
  resolveProjectId(): Promise<string | null>
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
 * The TUI side of the host session sandbox: writes the desired state for the current session
 * and follows the server's acknowledgement in the Forge database. The server reconciles the
 * request and routes the session's shell, glob, and grep calls into the sandbox.
 */
export function createHostSandboxToggle(deps: HostSandboxToggleDeps): HostSandboxToggle {
  const configEnabled = isSandboxConfigEnabled(deps.pluginConfig)
  const [preference, setPreference] = createSignal<SessionSandboxPreference | null>(null, { equals: preferencesEqual })
  const lifecycle = new AbortController()
  let projectId: string | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let waiter: AbortController | null = null

  const resolveProjectId = async (): Promise<string | null> => {
    projectId ??= await deps.resolveProjectId()
    return projectId
  }

  const refresh = (id: string): SessionSandboxPreference | null => {
    if (lifecycle.signal.aborted || !configEnabled) return null
    const pref = readSessionSandboxPreference(id, deps.dbPath)
    setPreference(pref)
    return pref
  }

  // Follows the preference pair independently of a toggle's own wait, so a late server
  // acknowledgement still reaches the sidebar.
  const ensurePolling = (id: string): void => {
    if (pollTimer || lifecycle.signal.aborted || !configEnabled) return
    const step = (): void => {
      pollTimer = null
      const pref = refresh(id)
      if (!pref) return
      pollTimer = setTimeout(step, deriveSandboxPollDelayMs(pref))
    }
    step()
  }

  if (configEnabled) {
    void resolveProjectId().then((id) => {
      if (id) ensurePolling(id)
    })
  }

  const toggle = async (): Promise<void> => {
    const blocked = hostSandboxToggleBlocked(configEnabled)
    if (blocked) {
      deps.toast({ message: blocked, variant: 'warning', duration: 5000 })
      return
    }
    const sessionId = deps.currentSessionId()
    if (!sessionId) {
      deps.toast({ message: 'Open a session first', variant: 'info', duration: 3000 })
      return
    }
    const id = await resolveProjectId()
    if (lifecycle.signal.aborted) return
    if (!id) {
      deps.toast({ message: 'Sandbox toggle unavailable: could not resolve this project', variant: 'warning', duration: 5000 })
      return
    }
    if (!existsSync(deps.dbPath)) {
      deps.toast({ message: `Sandbox toggle unavailable: no Forge database at ${deps.dbPath}`, variant: 'warning', duration: 5000 })
      return
    }
    const current = readSessionSandboxPreference(id, deps.dbPath)
    if (current.unavailable) {
      deps.toast({
        message: `Sandbox toggle unavailable: Forge preferences unreadable (${current.unavailableReason ?? 'unknown reason'})`,
        variant: 'warning',
        duration: 5000,
      })
      return
    }
    const enabling = !(current.desired?.enabled === true && current.desired.sessionId === sessionId)
    let revision: string | null = null
    const request = new AbortController()
    waiter?.abort()
    waiter = request
    try {
      revision = beginSessionSandboxStateRequest(id, deps.dbPath, { sessionId, enabled: enabling })
      refresh(id)
      ensurePolling(id)
      const applied = await awaitSessionSandboxState(id, deps.dbPath, revision, {
        timeoutMs: 15_000,
        pollMs: 250,
        signal: AbortSignal.any([request.signal, lifecycle.signal]),
      })
      const latest = refresh(id)
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
      const latest = refresh(id)
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
