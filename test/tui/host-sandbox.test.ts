import { afterEach, describe, expect, test } from 'vitest'
import { randomUUID } from 'crypto'
import { rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openForgeDatabase } from '../../src/storage/database'
import { createSessionSandboxPreferencesRepo } from '../../src/storage/repos/session-sandbox-preferences-repo'
import type { ForgeToastInput } from '../../src/host/forge-rpc'
import { createHostSandboxToggle, type HostSandboxToggle } from '../../src/tui/host-sandbox'

const PROJECT_ID = 'proj-host-sandbox'

describe('createHostSandboxToggle', () => {
  const dbPaths: string[] = []
  const toggles: HostSandboxToggle[] = []

  afterEach(() => {
    for (const toggle of toggles.splice(0)) toggle.dispose()
    for (const path of dbPaths.splice(0)) rmSync(path, { force: true })
  })

  function setup(options: { sessionId: string | null; sandboxEnabled?: boolean }) {
    const dbPath = join(tmpdir(), `forge-host-sandbox-${randomUUID()}.db`)
    dbPaths.push(dbPath)
    openForgeDatabase(dbPath).close()
    const toasts: ForgeToastInput[] = []
    const toggle = createHostSandboxToggle({
      pluginConfig: { sandbox: { enabled: options.sandboxEnabled ?? true } },
      dbPath,
      resolveProjectId: async () => PROJECT_ID,
      currentSessionId: () => options.sessionId,
      toast: (input) => toasts.push(input),
    })
    toggles.push(toggle)
    return { dbPath, toasts, toggle }
  }

  function acknowledge(dbPath: string): void {
    const db = openForgeDatabase(dbPath)
    try {
      const repo = createSessionSandboxPreferencesRepo(db)
      const desired = repo.getDesired(PROJECT_ID)
      if (!desired) throw new Error('no desired state written')
      repo.setApplied(PROJECT_ID, {
        version: 1,
        revision: desired.revision,
        enabled: desired.enabled,
        sessionId: desired.sessionId,
        error: null,
        appliedAt: Date.now(),
      })
    } finally {
      db.close()
    }
  }

  test('asks for a session when none is open', async () => {
    const { toasts, toggle } = setup({ sessionId: null })

    await toggle.toggle()

    expect(toasts).toEqual([{ message: 'Open a session first', variant: 'info', duration: 3000 }])
  })

  test('refuses to toggle when sandboxing is disabled by config', async () => {
    const { toasts, toggle } = setup({ sessionId: 'ses_1', sandboxEnabled: false })

    await toggle.toggle()

    expect(toasts[0]?.variant).toBe('warning')
    expect(toggle.preference()).toBeNull()
  })

  test('requests ON for the current session and reports the server acknowledgement', async () => {
    const { dbPath, toasts, toggle } = setup({ sessionId: 'ses_1' })

    const pending = toggle.toggle()
    setTimeout(() => acknowledge(dbPath), 50)
    await pending

    expect(toggle.preference()?.desired).toMatchObject({ enabled: true, sessionId: 'ses_1' })
    expect(toasts.at(-1)?.variant).toBe('success')
    expect(toasts.at(-1)?.message).toContain('Host sandbox enabled for this session')
  })

  test('a second toggle on the same session requests OFF', async () => {
    const { dbPath, toggle } = setup({ sessionId: 'ses_1' })

    const on = toggle.toggle()
    setTimeout(() => acknowledge(dbPath), 50)
    await on
    const off = toggle.toggle()
    setTimeout(() => acknowledge(dbPath), 50)
    await off

    expect(toggle.preference()?.desired).toMatchObject({ enabled: false, sessionId: 'ses_1' })
  })
})
