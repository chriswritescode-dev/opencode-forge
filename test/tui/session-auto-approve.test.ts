import { afterEach, describe, expect, test } from 'vitest'
import { randomUUID } from 'crypto'
import { rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openForgeDatabase } from '../../src/storage/database'
import {
  createSessionAutoApproveRepo,
  SESSION_AUTO_APPROVE_KEY_PREFIX,
} from '../../src/storage/repos/session-auto-approve-repo'
import type { ForgeToastInput } from '../../src/host/forge-rpc'
import { createSessionAutoApproveToggle, type SessionAutoApproveToggle } from '../../src/tui/session-auto-approve'

const PROJECT_ID = 'proj-session-auto-approve'

describe('createSessionAutoApproveToggle', () => {
  const dbPaths: string[] = []
  const toggles: SessionAutoApproveToggle[] = []

  afterEach(() => {
    for (const toggle of toggles.splice(0)) toggle.dispose()
    for (const path of dbPaths.splice(0)) rmSync(path, { force: true })
  })

  function setup(options: {
    sessionId: string | null
    dbPath?: string
    loopSession?: boolean
    sandboxed?: boolean
  }) {
    const dbPath = options.dbPath ?? join(tmpdir(), `forge-session-auto-approve-${randomUUID()}.db`)
    if (options.dbPath === undefined) {
      dbPaths.push(dbPath)
      openForgeDatabase(dbPath).close()
    }
    const toasts: ForgeToastInput[] = []
    const toggle = createSessionAutoApproveToggle({
      dbPath,
      resolveProjectId: async () => PROJECT_ID,
      currentSessionId: () => options.sessionId,
      isLoopSession: async () => options.loopSession ?? false,
      isSandboxedSession: () => options.sandboxed ?? false,
      toast: (input) => toasts.push(input),
    })
    toggles.push(toggle)
    return { dbPath, toasts, toggle }
  }

  function isEnabled(dbPath: string, sessionId: string): boolean {
    const db = openForgeDatabase(dbPath)
    try {
      return createSessionAutoApproveRepo(db).isEnabled(PROJECT_ID, sessionId, Date.now())
    } finally {
      db.close()
    }
  }

  function storedKeys(dbPath: string): string[] {
    const db = openForgeDatabase(dbPath)
    try {
      const rows = db
        .prepare('SELECT key FROM tui_preferences WHERE key LIKE ?')
        .all(`${SESSION_AUTO_APPROVE_KEY_PREFIX}%`) as Array<{ key: string }>
      return rows.map((row) => row.key)
    } finally {
      db.close()
    }
  }

  test('enables then disables auto-approve for the current session', async () => {
    const { dbPath, toasts, toggle } = setup({ sessionId: 'ses_1', sandboxed: true })

    await toggle.toggle()

    expect(isEnabled(dbPath, 'ses_1')).toBe(true)
    expect(toggle.enabled()).toBe(true)
    expect(toasts.at(-1)?.variant).toBe('success')
    expect(toasts.at(-1)?.message).toContain('Auto-approve enabled for this session and its subagents')

    await toggle.toggle()

    expect(isEnabled(dbPath, 'ses_1')).toBe(false)
    expect(toggle.enabled()).toBe(false)
    expect(toasts.at(-1)).toMatchObject({ message: 'Auto-approve disabled for this session', variant: 'success' })
  })

  test('asks for a session when none is open', async () => {
    const { dbPath, toasts, toggle } = setup({ sessionId: null })

    await toggle.toggle()

    expect(toasts).toEqual([{ message: 'Open a session first', variant: 'info', duration: 3000 }])
    expect(storedKeys(dbPath)).toEqual([])
  })

  test('refuses to toggle a loop session', async () => {
    const { dbPath, toasts, toggle } = setup({ sessionId: 'ses_loop', loopSession: true })

    await toggle.toggle()

    expect(toasts).toEqual([
      { message: 'Loop sessions already auto-approve everything not denied', variant: 'info', duration: 3000 },
    ])
    expect(storedKeys(dbPath)).toEqual([])
  })

  test('warns when the Forge database is missing', async () => {
    const dbPath = join(tmpdir(), `forge-session-auto-approve-missing-${randomUUID()}.db`)
    const { toasts, toggle } = setup({ sessionId: 'ses_1', dbPath })

    await toggle.toggle()

    expect(toasts[0]?.variant).toBe('warning')
    expect(toasts[0]?.message).toContain('Auto-approve unavailable')
  })

  test('warns that approved commands run on the host when the sandbox is off', async () => {
    const { toasts, toggle } = setup({ sessionId: 'ses_1', sandboxed: false })

    await toggle.toggle()

    expect(toasts.at(-1)?.variant).toBe('warning')
    expect(toasts.at(-1)?.message).toContain('Host sandbox is off')
  })

  test('reports success without the host warning when the sandbox is on', async () => {
    const { toasts, toggle } = setup({ sessionId: 'ses_1', sandboxed: true })

    await toggle.toggle()

    expect(toasts.at(-1)?.variant).toBe('success')
    expect(toasts.at(-1)?.message).not.toContain('Host sandbox is off')
  })
})
