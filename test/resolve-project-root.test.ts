import { describe, test, expect } from 'bun:test'
import { resolveHostSessionDirectory } from '../src/utils/resolve-project-root'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'

function makeV2(
  handler: (input: { sessionID: string; directory?: string }) => { data?: { directory?: string } } | Promise<{ data?: { directory?: string } }>,
): { v2: OpencodeClient; calls: Array<{ sessionID: string; directory?: string }> } {
  const calls: Array<{ sessionID: string; directory?: string }> = []
  const v2 = {
    session: {
      get: async (input: { sessionID: string; directory?: string }) => {
        calls.push(input)
        return handler(input)
      },
    },
  } as unknown as OpencodeClient
  return { v2, calls }
}

describe('resolveHostSessionDirectory', () => {
  test('returns null when no host session id is provided', async () => {
    const { v2, calls } = makeV2(() => ({ data: { directory: '/should/not/be/used' } }))
    const result = await resolveHostSessionDirectory(v2, undefined, '/fallback')
    expect(result).toBeNull()
    expect(calls.length).toBe(0)
  })

  test('resolves the host session directory (the real project root)', async () => {
    const { v2, calls } = makeV2(() => ({ data: { directory: '/Users/chris/development/oc-manager' } }))
    const result = await resolveHostSessionDirectory(v2, 'ses_host', '/worktree/path')
    expect(result).toBe('/Users/chris/development/oc-manager')
    expect(calls[0]).toEqual({ sessionID: 'ses_host' })
  })

  test('falls back to a directory-scoped lookup when the first attempt is empty', async () => {
    const { v2, calls } = makeV2((input) =>
      input.directory ? { data: { directory: '/Users/chris/development/sd-mono' } } : { data: {} },
    )
    const result = await resolveHostSessionDirectory(v2, 'ses_host', '/worktree/path')
    expect(result).toBe('/Users/chris/development/sd-mono')
    expect(calls.length).toBe(2)
    expect(calls[1]).toEqual({ sessionID: 'ses_host', directory: '/worktree/path' })
  })

  test('returns null when all lookups fail', async () => {
    const { v2 } = makeV2(() => {
      throw new Error('not found')
    })
    const result = await resolveHostSessionDirectory(v2, 'ses_host', '/worktree/path')
    expect(result).toBeNull()
  })
})
