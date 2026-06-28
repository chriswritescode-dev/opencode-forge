import { describe, test, expect } from 'vitest'
import { resolveHostSessionDirectory } from '../src/utils/resolve-project-root'
import { createFakeForgeClient } from './helpers/fake-client'

function makeClient(
  handler: (input: { sessionID: string; directory?: string }) => { directory?: string } | Promise<{ directory?: string }>,
): { calls: Array<{ sessionID: string; directory?: string }> } {
  const calls: Array<{ sessionID: string; directory?: string }> = []
  createFakeForgeClient({
    session: {
      get: async (input: any) => {
        calls.push(input as { sessionID: string; directory?: string })
        return handler(input as { sessionID: string; directory?: string })
      },
    },
  })
  return { calls }
}

describe('resolveHostSessionDirectory', () => {
  test('returns null when no host session id is provided', async () => {
    const { client } = createFakeForgeClient({
      session: {
        get: async () => ({ directory: '/should/not/be/used' }),
      },
    })
    const result = await resolveHostSessionDirectory(client, undefined, '/fallback')
    expect(result).toBeNull()
  })

  test('resolves the host session directory (the real project root)', async () => {
    const calls: Array<{ sessionID: string; directory?: string }> = []
    const { client } = createFakeForgeClient({
      session: {
        get: async (input: any) => {
          calls.push(input as any)
          return { directory: '/Users/chris/development/oc-manager' }
        },
      },
    })
    const result = await resolveHostSessionDirectory(client, 'ses_host', '/worktree/path')
    expect(result).toBe('/Users/chris/development/oc-manager')
    expect(calls[0]).toEqual({ sessionID: 'ses_host' })
  })

  test('falls back to a directory-scoped lookup when the first attempt is empty', async () => {
    const calls: Array<{ sessionID: string; directory?: string }> = []
    const { client } = createFakeForgeClient({
      session: {
        get: async (input: any) => {
          calls.push(input)
          if (input.directory) {
            return { directory: '/Users/chris/development/sd-mono' }
          }
          return {}
        },
      },
    })
    const result = await resolveHostSessionDirectory(client, 'ses_host', '/worktree/path')
    expect(result).toBe('/Users/chris/development/sd-mono')
    expect(calls.length).toBe(2)
    expect(calls[1]).toEqual({ sessionID: 'ses_host', directory: '/worktree/path' })
  })

  test('returns null when all lookups fail', async () => {
    const { client } = createFakeForgeClient({
      session: {
        get: async () => { throw new Error('not found') },
      },
    })
    const result = await resolveHostSessionDirectory(client, 'ses_host', '/worktree/path')
    expect(result).toBeNull()
  })
})
