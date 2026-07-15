export interface ProviderErrorSignal {
  name?: string
  message?: string
  statusCode?: number
}

const USAGE_LIMIT_PATTERN = /usage\s*limit|quota\s*(?:exceeded|reached)/i

/**
 * Extract a {@link ProviderErrorSignal} from any error value, including
 * `ForgeClientError` instances whose `cause` carries the original SDK error
 * with `name`, `data.message`, and `data.statusCode` properties.
 *
 * Returns a best-effort signal; callers should check each field independently
 * before passing to {@link classifyProviderLimit}.
 */
export function extractErrorSignal(err: unknown): ProviderErrorSignal {
  if (!err || typeof err !== 'object') {
    return { message: err != null ? String(err) : undefined }
  }

  const obj = err as Record<string, unknown>

  const cause = (obj as { cause?: unknown }).cause
  if (cause && typeof cause === 'object') {
    const c = cause as Record<string, unknown>
    const causeName = typeof c.name === 'string' ? c.name : undefined
    const causeData = c.data && typeof c.data === 'object' ? c.data as Record<string, unknown> : undefined
    const causeMessage = typeof c.message === 'string'
      ? c.message
      : typeof causeData?.message === 'string' ? causeData.message : undefined
    const causeStatusCode = typeof causeData?.statusCode === 'number' ? causeData.statusCode : undefined

    if (causeName || causeMessage || causeStatusCode) {
      return { name: causeName, message: causeMessage, statusCode: causeStatusCode }
    }
  }

  const name = typeof obj.name === 'string' ? obj.name : undefined
  const data = obj.data && typeof obj.data === 'object' ? obj.data as Record<string, unknown> : undefined
  const message = typeof obj.message === 'string'
    ? obj.message
    : typeof data?.message === 'string' ? data.message : undefined
  const statusCode = typeof data?.statusCode === 'number' ? data.statusCode : undefined

  return { name, message, statusCode }
}

/** Returns a human-readable reason when the signal represents a fatal provider limit (usage limit, 403, auth), otherwise null. */
export function classifyProviderLimit(signal: ProviderErrorSignal): string | null {
  if (signal.name === 'ProviderAuthError') {
    return `provider auth error: ${signal.message ?? 'unknown'}`
  }

  if (signal.statusCode === 403) {
    return `provider returned 403: ${signal.message ?? 'forbidden'}`
  }

  if (signal.message && USAGE_LIMIT_PATTERN.test(signal.message)) {
    return `provider usage limit: ${signal.message}`
  }

  return null
}
