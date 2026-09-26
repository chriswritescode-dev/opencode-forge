import { existsSync } from 'fs'
import { createSignal, type Accessor } from 'solid-js'
import type { ForgeToastInput } from '../host/forge-rpc'
import {
  createSessionAutoApproveRepo,
  SESSION_AUTO_APPROVE_TTL_MS,
  type SessionAutoApproveRepo,
} from '../storage/repos/session-auto-approve-repo'
import { openForgeDb } from './session-sandbox-store'

/** How often the flag is re-read so switching the viewed session updates the signal. */
const AUTO_APPROVE_POLL_INTERVAL_MS = 2000

const TTL_DAYS = Math.round(SESSION_AUTO_APPROVE_TTL_MS / (24 * 60 * 60 * 1000))

const ENABLED_MESSAGE =
  `Auto-approve enabled for this session and its subagents. Nothing will prompt: ask rules and autoApprove.deny rules are denied, everything else is allowed. Expires after ${TTL_DAYS} days idle.`

export interface SessionAutoApproveToggleDeps {
  dbPath: string
  resolveProjectId(): Promise<string | null>
  currentSessionId(): string | null
  isLoopSession(sessionId: string): Promise<boolean>
  isSandboxedSession(sessionId: string): boolean
  toast(input: ForgeToastInput): void
  now?: () => number
}

export interface SessionAutoApproveToggle {
  /** Whether auto-approve is on for the session currently on the route. */
  enabled: Accessor<boolean>
  toggle(): Promise<void>
  dispose(): void
}

/**
 * The TUI side of per-session auto-approve: flips the Forge-database flag for the
 * session on the current route and follows it so switching sessions updates the
 * sidebar. The server reads the same flag in its permission hook and resolves every
 * prompt for the session and its subagents to allow or deny without prompting.
 */
export function createSessionAutoApproveToggle(deps: SessionAutoApproveToggleDeps): SessionAutoApproveToggle {
  const now = deps.now ?? (() => Date.now())
  const [enabled, setEnabled] = createSignal(false)
  const lifecycle = new AbortController()
  let projectId: string | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null

  const resolveProjectId = async (): Promise<string | null> => {
    projectId ??= await deps.resolveProjectId()
    return projectId
  }

  const withRepo = <T>(use: (repo: SessionAutoApproveRepo) => T): T => {
    const db = openForgeDb(deps.dbPath)
    if (!db) throw new Error(`no Forge database at ${deps.dbPath}`)
    try {
      return use(createSessionAutoApproveRepo(db))
    } finally {
      db.close()
    }
  }

  const readEnabled = (id: string, sessionId: string): boolean => {
    try {
      return withRepo((repo) => repo.isEnabled(id, sessionId, now()))
    } catch {
      return false
    }
  }

  const refresh = async (): Promise<void> => {
    if (lifecycle.signal.aborted) return
    const sessionId = deps.currentSessionId()
    if (!sessionId) {
      setEnabled(false)
      return
    }
    let id: string | null
    try {
      id = await resolveProjectId()
    } catch {
      id = null
    }
    if (lifecycle.signal.aborted) return
    setEnabled(id ? readEnabled(id, sessionId) : false)
  }

  const schedule = (): void => {
    if (lifecycle.signal.aborted) return
    pollTimer = setTimeout(() => {
      pollTimer = null
      void refresh().finally(schedule)
    }, AUTO_APPROVE_POLL_INTERVAL_MS)
  }

  void refresh().finally(schedule)

  const writeEnabled = (id: string, sessionId: string, next: boolean): void => {
    withRepo((repo) => {
      if (next) repo.enable(id, sessionId, now())
      else repo.disable(id, sessionId)
    })
  }

  const toggle = async (): Promise<void> => {
    const sessionId = deps.currentSessionId()
    if (!sessionId) {
      deps.toast({ message: 'Open a session first', variant: 'info', duration: 3000 })
      return
    }
    const id = await resolveProjectId()
    if (lifecycle.signal.aborted) return
    if (!id) {
      deps.toast({ message: 'Auto-approve unavailable: could not resolve this project', variant: 'warning', duration: 5000 })
      return
    }
    if (!existsSync(deps.dbPath)) {
      deps.toast({ message: `Auto-approve unavailable: no Forge database at ${deps.dbPath}`, variant: 'warning', duration: 5000 })
      return
    }
    if (await deps.isLoopSession(sessionId)) {
      deps.toast({ message: 'Loop sessions already auto-approve everything not denied', variant: 'info', duration: 3000 })
      return
    }
    if (lifecycle.signal.aborted) return
    const next = !readEnabled(id, sessionId)
    try {
      writeEnabled(id, sessionId, next)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      deps.toast({ message: `Auto-approve toggle failed: ${message}`, variant: 'error', duration: 6000 })
      return
    }
    setEnabled(next)
    if (!next) {
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
    toggle,
    dispose() {
      lifecycle.abort()
      if (pollTimer) clearTimeout(pollTimer)
      pollTimer = null
    },
  }
}
