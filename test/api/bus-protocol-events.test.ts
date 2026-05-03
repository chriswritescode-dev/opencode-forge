import { describe, it, expect } from 'bun:test'
import { encodeEvent, decodeEvent, encodeReply, decodeReply } from '../../src/api/bus-protocol'

describe('ForgeBusEvent encoding/decoding', () => {
  it('should round-trip encode/decode with all fields', () => {
    const original = {
      name: 'loops.changed',
      projectId: 'test-project',
      directory: '/test/dir',
      payload: { reason: 'insert', loopName: 'foo' },
    }

    const encoded = encodeEvent(original)
    const decoded = decodeEvent(encoded)

    expect(decoded).toEqual(original)
  })

  it('should round-trip encode/decode without projectId', () => {
    const original = {
      name: 'loops.changed',
      directory: '/test/dir',
      payload: { reason: 'terminate', loopName: 'bar' },
    }

    const encoded = encodeEvent(original)
    const decoded = decodeEvent(encoded)

    expect(decoded).toEqual(original)
  })

  it('should round-trip encode/decode without directory', () => {
    const original = {
      name: 'loops.changed',
      projectId: 'test-project',
      payload: { reason: 'rotate', loopName: 'baz' },
    }

    const encoded = encodeEvent(original)
    const decoded = decodeEvent(encoded)

    expect(decoded).toEqual(original)
  })

  it('should round-trip encode/decode with minimal fields', () => {
    const original = {
      name: 'loops.changed',
      payload: { reason: 'status', loopName: 'qux' },
    }

    const encoded = encodeEvent(original)
    const decoded = decodeEvent(encoded)

    expect(decoded).toEqual(original)
  })

  it('should return null for forge.req: prefix', () => {
    const result = decodeEvent('forge.req:test:rid:eyJwYXJhbXMiOnt9fQ==')
    expect(result).toBeNull()
  })

  it('should return null for forge.rep: prefix', () => {
    const result = decodeEvent('forge.rep:rid:ok:eyJkYXRhIjp7fX0=')
    expect(result).toBeNull()
  })

  it('should return null for arbitrary strings', () => {
    const result = decodeEvent('random-string')
    expect(result).toBeNull()
  })

  it('should return null for malformed base64', () => {
    const result = decodeEvent('forge.evt:test:invalid-base64!!!')
    expect(result).toBeNull()
  })
})

describe('decodeReply should not decode forge.evt:', () => {
  it('should return null for forge.evt: prefix', () => {
    const result = decodeReply('forge.evt:loops.changed:eyJwYXlsb2FkIjp7fX0=')
    expect(result).toBeNull()
  })
})
