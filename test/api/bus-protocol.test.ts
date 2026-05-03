import { describe, it, expect } from 'bun:test'
import { encodeRequest, decodeRequest, encodeReply, decodeReply, newRid, encodeEvent, decodeEvent } from '../../src/api/bus-protocol'

describe('bus-protocol', () => {
  it('round-trips a request with string body', () => {
    const req = {
      verb: 'plan.read.session',
      rid: 'abc123',
      directory: '/test',
      projectId: 'proj1',
      params: { sessionId: 's1' },
      body: { content: 'test' },
    }
    const encoded = encodeRequest(req)
    const decoded = decodeRequest(encoded)
    expect(decoded).toEqual(req)
  })

  it('round-trips a request with object body', () => {
    const req = {
      verb: 'loops.start',
      rid: 'xyz789',
      directory: '/test',
      projectId: 'proj1',
      params: {},
      body: { plan: 'do something', title: 'Test', worktree: true },
    }
    const encoded = encodeRequest(req)
    const decoded = decodeRequest(encoded)
    expect(decoded).toEqual(req)
  })

  it('returns null for non-forge command', () => {
    expect(decodeRequest('unknown.verb')).toBeNull()
  })

  it('returns null for malformed base64', () => {
    expect(decodeRequest('forge.req:plan.read:abc123:!!!invalid!!!')).toBeNull()
  })

  it('round-trips an ok reply', () => {
    const reply = {
      rid: 'abc123',
      status: 'ok' as const,
      data: { sessionId: 's1', content: 'plan content' },
    }
    const encoded = encodeReply(reply)
    const decoded = decodeReply(encoded)
    expect(decoded).toEqual(reply)
  })

  it('round-trips an err reply', () => {
    const reply = {
      rid: 'abc123',
      status: 'err' as const,
      code: 'not_found',
      message: 'plan not found',
    }
    const encoded = encodeReply(reply)
    const decoded = decodeReply(encoded)
    expect(decoded).toEqual(reply)
  })

  it('returns null for non-forge reply', () => {
    expect(decodeReply('unknown.status:ok:abc')).toBeNull()
  })

  it('handles large payloads (~50 KB)', () => {
    const largeContent = 'x'.repeat(50 * 1024)
    const req = {
      verb: 'plan.write.session',
      rid: 'large',
      directory: '/test',
      projectId: 'proj1',
      params: { sessionId: 's1' },
      body: { content: largeContent },
    }
    const encoded = encodeRequest(req)
    const decoded = decodeRequest(encoded)
    expect(decoded).toEqual(req)
  })

  it('generates unique rids', () => {
    const rid1 = newRid()
    const rid2 = newRid()
    expect(rid1).not.toBe(rid2)
    expect(rid1.length).toBe(8) // UUID first segment
  })

  it('decodes request with optional directory and projectId', () => {
    const req = {
      verb: 'projects.list',
      rid: 'test',
      params: {},
      body: undefined,
    }
    const encoded = encodeRequest({ ...req, directory: undefined, projectId: undefined })
    const decoded = decodeRequest(encoded)
    expect(decoded).toEqual({ ...req, directory: undefined, projectId: undefined })
  })

  it('round-trips an event', () => {
    const evt = {
      rid: 'abc123',
      name: 'loop.started',
      data: { sessionId: 's1', loopName: 'test-loop' },
    }
    const encoded = encodeEvent(evt)
    const decoded = decodeEvent(encoded)
    expect(decoded).toEqual(evt)
  })

  it('returns null for non-forge event', () => {
    expect(decodeEvent('forge.rep:abc:ok:base64')).toBeNull()
    expect(decodeEvent('unknown.prefix:loop.started:abc:base64')).toBeNull()
  })

  it('returns null for malformed event string', () => {
    expect(decodeEvent('forge.evt:loop.started:abc')).toBeNull()
    expect(decodeEvent('forge.evt:loop.started:abc:!!!invalid!!!')).toBeNull()
  })

  it('does not collide with reply decoder', () => {
    const replyStr = encodeReply({ rid: 'abc', status: 'ok', data: { test: 1 } })
    expect(decodeEvent(replyStr)).toBeNull()
    expect(decodeReply(replyStr)).toBeTruthy()
  })
})
