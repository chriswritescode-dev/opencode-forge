import { describe, it, expect } from 'vitest'
import {
  findSessionAncestor,
  tolerateUndeterminedParent,
  ParentLookupUndeterminedError,
  MAX_SESSION_ANCESTOR_DEPTH,
} from '../../src/utils/session-ancestry'

function chainLookup(chain: Record<string, string | null>) {
  return async (sessionId: string): Promise<string | null> => chain[sessionId] ?? null
}

describe('findSessionAncestor', () => {
  it('matches a multi-hop ancestor', async () => {
    const lookup = chainLookup({ deep: 'sub', sub: 'root' })
    const found = await findSessionAncestor('deep', lookup, (parentId) => (parentId === 'root' ? 'hit' : null))
    expect(found).toBe('hit')
  })

  it('returns null for an unrelated session', async () => {
    const lookup = chainLookup({ other: null })
    const found = await findSessionAncestor('other', lookup, (parentId) => (parentId === 'root' ? 'hit' : null))
    expect(found).toBeNull()
  })

  it('propagates an undetermined parent lookup instead of reporting no ancestor', async () => {
    const lookup = async (sessionId: string): Promise<string | null> => {
      throw new ParentLookupUndeterminedError(sessionId, 'host:not-found')
    }

    // This is what makes sandbox routing fail closed: `isWithinSession` must not be able to
    // conclude "not a descendant" from a lookup that never answered.
    await expect(
      findSessionAncestor('sub', lookup, (parentId) => (parentId === 'root' ? 'hit' : null)),
    ).rejects.toBeInstanceOf(ParentLookupUndeterminedError)
  })

  it('propagates an undetermined lookup that happens partway up the chain', async () => {
    const lookup = async (sessionId: string): Promise<string | null> => {
      if (sessionId === 'deep') return 'sub'
      throw new ParentLookupUndeterminedError(sessionId, 'host:not-found')
    }

    await expect(
      findSessionAncestor('deep', lookup, (parentId) => (parentId === 'root' ? 'hit' : null)),
    ).rejects.toBeInstanceOf(ParentLookupUndeterminedError)
  })

  it('stops at the depth cap without looping forever on a cycle', async () => {
    const lookup = chainLookup({ a: 'b', b: 'a' })
    expect(await findSessionAncestor('a', lookup, () => null)).toBeNull()

    let hops = 0
    const endless = async (): Promise<string | null> => `gen-${hops++}`
    await findSessionAncestor('start', endless, () => null)
    expect(hops).toBe(MAX_SESSION_ANCESTOR_DEPTH)
  })
})

describe('tolerateUndeterminedParent', () => {
  it('converts an undetermined lookup into "unresolved" for loop bookkeeping', async () => {
    const walk = Promise.reject(new ParentLookupUndeterminedError('sub', 'host:not-found'))
    expect(await tolerateUndeterminedParent(walk)).toBeNull()
  })

  it('still propagates every other failure', async () => {
    const walk = Promise.reject(new Error('Unable to connect'))
    await expect(tolerateUndeterminedParent(walk)).rejects.toThrow(/Unable to connect/)
  })

  it('passes a resolved ancestor through untouched', async () => {
    expect(await tolerateUndeterminedParent(Promise.resolve('loop-a'))).toBe('loop-a')
  })
})
