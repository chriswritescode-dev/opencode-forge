import { z } from 'zod'
import { ForgeClientError, type ForgeClientErrorKind } from './port'

const messageCarrierSchema = z.looseObject({ message: z.string() })
const dataMessageCarrierSchema = z.looseObject({ data: z.looseObject({ message: z.string() }) })
const stringMessageSchema = z.string()

function extractMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  const text = stringMessageSchema.safeParse(cause)
  if (text.success) return text.data
  const direct = messageCarrierSchema.safeParse(cause)
  if (direct.success) return direct.data.message
  const nested = dataMessageCarrierSchema.safeParse(cause)
  if (nested.success) return nested.data.data.message
  try {
    return JSON.stringify(cause)
  } catch {
    return String(cause)
  }
}

export function classify(cause: unknown, method: string): ForgeClientError {
  const rawMessage = extractMessage(cause)
  let kind: ForgeClientErrorKind = 'request'
  if (/Unable to connect|fetch failed|ECONNREFUSED/i.test(rawMessage)) {
    kind = 'connection'
  } else if (/not found/i.test(rawMessage)) {
    kind = 'not-found'
  }
  return new ForgeClientError({ kind, method, message: rawMessage, cause })
}

export function unavailableError(method: string, message: string): ForgeClientError {
  return new ForgeClientError({ kind: 'unavailable', method, message })
}

export function requestError(method: string, message: string): ForgeClientError {
  return new ForgeClientError({ kind: 'request', method, message })
}
