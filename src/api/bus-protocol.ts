import { randomUUID } from 'crypto'

export type ForgeRpcRequest = {
  verb: string
  rid: string
  directory?: string
  projectId?: string
  params: Record<string, string>
  body: unknown
}

export type ForgeRpcReplyOk = {
  rid: string
  status: 'ok'
  data: unknown
}

export type ForgeRpcReplyErr = {
  rid: string
  status: 'err'
  code: string
  message: string
}

export type ForgeRpcReply = ForgeRpcReplyOk | ForgeRpcReplyErr

export type ForgeRpcEvent = {
  rid: string
  name: string
  data: unknown
}

export class ForgeRpcError extends Error {
  constructor(public code: string, message: string) {
    super(message)
  }
}

export type ForgeBusEvent = {
  name: string                  // e.g. 'loops.changed'
  projectId?: string
  directory?: string
  payload?: unknown
}

export type ForgeEvent = ForgeRpcEvent | ForgeBusEvent

function encode(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function decode<T>(str: string): T | null {
  try {
    const json = Buffer.from(str, 'base64url').toString('utf8')
    return JSON.parse(json) as T
  } catch {
    return null
  }
}

export function newRid(): string {
  return randomUUID().split('-')[0]
}

export function encodeRequest(req: ForgeRpcRequest): string {
  const { verb, rid, directory, projectId, params, body } = req
  const payload = { params, body, projectId, directory }
  return `forge.req:${verb}:${rid}:${encode(payload)}`
}

export function decodeRequest(command: string): ForgeRpcRequest | null {
  if (!command.startsWith('forge.req:')) {
    return null
  }

  const parts = command.split(':')
  if (parts.length < 4) {
    return null
  }

  const verb = parts[1]
  const rid = parts[2]
  const b64 = parts.slice(3).join(':')

  const payload = decode<{ params: Record<string, string>; body: unknown; projectId?: string; directory?: string }>(b64)
  if (!payload) {
    return null
  }

  return {
    verb,
    rid,
    params: payload.params,
    body: payload.body,
    projectId: payload.projectId,
    directory: payload.directory,
  }
}

export function encodeReply(reply: ForgeRpcReply): string {
  const { rid, status } = reply
  const payload = status === 'ok' ? { data: reply.data } : { code: reply.code, message: reply.message }
  return `forge.rep:${rid}:${status}:${encode(payload)}`
}

export function decodeReply(command: string): ForgeRpcReply | null {
  if (!command.startsWith('forge.rep:')) {
    return null
  }

  const parts = command.split(':')
  if (parts.length < 4) {
    return null
  }

  const rid = parts[1]
  const status = parts[2] as 'ok' | 'err'
  const b64 = parts.slice(3).join(':')

  const payload = decode<{ data?: unknown; code?: string; message?: string }>(b64)
  if (!payload) {
    return null
  }

  if (status === 'ok') {
    return { rid, status, data: payload.data ?? null }
  } else {
    return { rid, status, code: payload.code ?? 'unknown', message: payload.message ?? 'unknown error' }
  }
}

export function encodeEvent(evt: ForgeEvent): string {
  if ('rid' in evt) {
    const { rid, name, data } = evt
    return `forge.evt:${name}:${rid}:${encode({ data })}`
  }

  const { name, projectId, directory, payload } = evt
  return `forge.evt:${name}:${encode({ projectId, directory, payload })}`
}

export function decodeEvent(command: string): ForgeEvent | null {
  if (!command.startsWith('forge.evt:')) {
    return null
  }

  const parts = command.split(':')
  if (parts.length < 3) {
    return null
  }

  const name = parts[1]

  if (parts.length >= 4) {
    const rid = parts[2]
    const b64 = parts.slice(3).join(':')

    const payload = decode<{ data?: unknown }>(b64)
    if (!payload) {
      return null
    }

    return { rid, name, data: payload.data ?? null }
  }

  const b64 = parts.slice(2).join(':')

  const payload = decode<{ projectId?: string; directory?: string; payload?: unknown }>(b64)
  if (!payload) {
    return null
  }

  return {
    name,
    projectId: payload.projectId,
    directory: payload.directory,
    payload: payload.payload,
  }
}
