import { describe, test, expect } from 'bun:test'
import { createFakeForgeClient, type RecordedCall, type CreateFakeForgeClientResult } from './fake-client'
import type { ForgeClient } from '../../src/client/port'

// ---------------------------------------------------------------------------
// Compile-time assertions — consumers never need `as any`
// ---------------------------------------------------------------------------
const _typeCheck: ForgeClient = createFakeForgeClient().client
const _typeCheck2: CreateFakeForgeClientResult = createFakeForgeClient()

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createFakeForgeClient', () => {
  // ── Defaults ──────────────────────────────────────────────────────────────

  test('session.create returns incremental IDs', async () => {
    const { client } = createFakeForgeClient()

    const a = await client.session.create({ directory: '/tmp', title: 'session A' })
    const b = await client.session.create({ directory: '/tmp', title: 'session B' })

    expect(a.id).toBe('ses_fake_1')
    expect(b.id).toBe('ses_fake_2')
  })

  test('session.get returns a default session', async () => {
    const { client } = createFakeForgeClient()
    const result = await client.session.get({ sessionID: 's1', directory: '/tmp' })
    expect(result).toEqual({ id: 'ses_fake_1' })
  })

  test('session.update resolves to undefined', async () => {
    const { client } = createFakeForgeClient()
    await expect(client.session.update({ sessionID: 's1', directory: '/tmp' })).resolves.toBeUndefined()
  })

  test('session.messages returns empty array', async () => {
    const { client } = createFakeForgeClient()
    const result = await client.session.messages({ sessionID: 's1', directory: '/tmp', limit: 10 })
    expect(result).toEqual([])
  })

  test('session.status returns empty object', async () => {
    const { client } = createFakeForgeClient()
    const result = await client.session.status()
    expect(result).toEqual({})
  })

  test('session.promptAsync resolves to undefined', async () => {
    const { client } = createFakeForgeClient()
    await expect(
      client.session.promptAsync({
        sessionID: 's1',
        directory: '/tmp',
        agent: 'code',
        parts: [{ type: 'text', text: 'hello' }],
      }),
    ).resolves.toBeUndefined()
  })

  test('session.abort resolves to undefined', async () => {
    const { client } = createFakeForgeClient()
    await expect(client.session.abort({ sessionID: 's1' })).resolves.toBeUndefined()
  })

  test('session.delete resolves to undefined', async () => {
    const { client } = createFakeForgeClient()
    await expect(client.session.delete({ sessionID: 's1', directory: '/tmp' })).resolves.toBeUndefined()
  })

  test('workspace.create returns incremental IDs', async () => {
    const { client } = createFakeForgeClient()

    const a = await client.workspace.create({ directory: '/a' })
    const b = await client.workspace.create({ directory: '/b' })

    expect(a.id).toBe('ws_fake_1')
    expect(b.id).toBe('ws_fake_2')
  })

  test('workspace.list returns empty array', async () => {
    const { client } = createFakeForgeClient()
    const result = await client.workspace.list()
    expect(result).toEqual([])
  })

  test('workspace.status returns empty object', async () => {
    const { client } = createFakeForgeClient()
    const result = await client.workspace.status()
    expect(result).toEqual({})
  })

  test('workspace.syncList resolves to undefined', async () => {
    const { client } = createFakeForgeClient()
    await expect(client.workspace.syncList()).resolves.toBeUndefined()
  })

  test('workspace.remove resolves to undefined', async () => {
    const { client } = createFakeForgeClient()
    await expect(client.workspace.remove({ id: 's1', directory: '/tmp' })).resolves.toBeUndefined()
  })

  test('workspace.warp resolves to undefined', async () => {
    const { client } = createFakeForgeClient()
    await expect(client.workspace.warp({ id: 'ws-1', sessionID: 's1' })).resolves.toBeUndefined()
  })

  test('tui.publish resolves to undefined', async () => {
    const { client } = createFakeForgeClient()
    await expect(client.tui.publish({ directory: '/tmp' })).resolves.toBeUndefined()
  })

  test('tui.selectSession resolves to undefined', async () => {
    const { client } = createFakeForgeClient()
    await expect(client.tui.selectSession({ sessionID: 's1' })).resolves.toBeUndefined()
  })

  test('sync.start resolves to undefined', async () => {
    const { client } = createFakeForgeClient()
    await expect(client.sync.start({ directory: '/tmp' })).resolves.toBeUndefined()
  })

  // ── Overrides ─────────────────────────────────────────────────────────

  test('overrides take effect for session.create', async () => {
    const { client } = createFakeForgeClient({
      session: { create: async () => ({ id: 'custom-session' }) },
    })

    const result = await client.session.create({ directory: '/tmp' })
    expect(result).toEqual({ id: 'custom-session' })
  })

  test('overrides take effect for workspace.create', async () => {
    const { client } = createFakeForgeClient({
      workspace: { create: async () => ({ id: 'custom-ws' }) },
    })

    const result = await client.workspace.create({ directory: '/tmp' })
    expect(result).toEqual({ id: 'custom-ws' })
  })

  test('overrides take effect for void methods', async () => {
    const { client } = createFakeForgeClient({
      session: { update: async () => { throw new Error('override-error') } },
    })

    await expect(client.session.update({ sessionID: 's1', directory: '/tmp' })).rejects.toThrow('override-error')
  })

  test('un-overridden methods still use defaults', async () => {
    const { client } = createFakeForgeClient({
      session: { create: async () => ({ id: 'custom' }) },
    })

    // create is overridden
    const session = await client.session.create({ directory: '/tmp' })
    expect(session.id).toBe('custom')

    // get is still the default
    const getResult = await client.session.get({ sessionID: 's1', directory: '/tmp' })
    expect(getResult.id).toBe('ses_fake_1')
  })

  // ── Call recording ─────────────────────────────────────────────────────

  test('calls are recorded in invocation order across namespaces', async () => {
    const { client, calls } = createFakeForgeClient()

    await client.session.create({ directory: '/a' })
    await client.workspace.create({ directory: '/b' })
    await client.session.messages({ sessionID: 'a', directory: '/tmp', limit: 5 })
    await client.tui.publish({ directory: '/tmp' })

    expect(calls).toHaveLength(4)
    expect(calls[0]).toEqual<RecordedCall>({ method: 'session.create', params: { directory: '/a' } })
    expect(calls[1]).toEqual<RecordedCall>({ method: 'workspace.create', params: { directory: '/b' } })
    expect(calls[2]).toEqual<RecordedCall>({ method: 'session.messages', params: { sessionID: 'a', directory: '/tmp', limit: 5 } })
    expect(calls[3]).toEqual<RecordedCall>({ method: 'tui.publish', params: { directory: '/tmp' } })
  })

  test('override invocations are still recorded', async () => {
    const { client, calls } = createFakeForgeClient({
      session: { create: async () => ({ id: 'custom' }) },
    })

    await client.session.create({ directory: '/tmp', title: 'test' })

    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('session.create')
    expect(calls[0].params).toEqual({ directory: '/tmp', title: 'test' })
  })
})
