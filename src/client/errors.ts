import { ForgeClientError, type ForgeClientErrorKind } from './port'

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>
    if (typeof obj.message === 'string') return obj.message
    if (obj.data && typeof obj.data === 'object') {
      const data = obj.data as Record<string, unknown>
      if (typeof data.message === 'string') return data.message
    }
  }
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

export function classify(err: unknown, method: string): ForgeClientError {
  const rawMessage = extractMessage(err)
  let kind: ForgeClientErrorKind = 'request'
  if (/Unable to connect|fetch failed|ECONNREFUSED/i.test(rawMessage)) {
    kind = 'connection'
  } else if (/not found/i.test(rawMessage)) {
    kind = 'not-found'
  }
  return new ForgeClientError({ kind, method, message: rawMessage, cause: err })
}

export function unavailableError(method: string, message: string): ForgeClientError {
  return new ForgeClientError({ kind: 'unavailable', method, message })
}

export function requestError(method: string, message: string): ForgeClientError {
  return new ForgeClientError({ kind: 'request', method, message })
}
