import { z } from 'zod'

export interface ProviderErrorSignal {
  name?: string
  message?: string
  statusCode?: number
}

const USAGE_LIMIT_PATTERN = /usage\s*limit|quota\s*(?:exceeded|reached)/i

const providerErrorDataSchema = z.looseObject({
  message: z.string().optional().catch(undefined),
  statusCode: z.number().optional().catch(undefined),
})

const providerErrorCauseSchema = z.looseObject({
  name: z.string().optional().catch(undefined),
  message: z.string().optional().catch(undefined),
  data: providerErrorDataSchema.optional().catch(undefined),
}).optional().catch(undefined)

const providerErrorSchema = z.looseObject({
  name: z.string().optional().catch(undefined),
  message: z.string().optional().catch(undefined),
  data: providerErrorDataSchema.optional().catch(undefined),
  cause: providerErrorCauseSchema,
})

function selectMessage(primary: string | undefined, fallback: string | undefined): string | undefined {
  if (primary && USAGE_LIMIT_PATTERN.test(primary)) return primary
  if (fallback && USAGE_LIMIT_PATTERN.test(fallback)) return fallback
  return primary ?? fallback
}

export function extractErrorSignal(cause: unknown): ProviderErrorSignal {
  const parsed = providerErrorSchema.safeParse(cause)
  if (!parsed.success) {
    const text = z.string().safeParse(cause)
    if (text.success) return { message: text.data }
    return { message: cause == null ? undefined : String(cause) }
  }

  const error = parsed.data
  if (error.cause) {
    const causeMessage = selectMessage(error.cause.data?.message, error.cause.message)
    const causeStatusCode = error.cause.data?.statusCode

    if (error.cause.name || causeMessage || causeStatusCode) {
      return { name: error.cause.name, message: causeMessage, statusCode: causeStatusCode }
    }
  }

  const message = selectMessage(error.data?.message, error.message)
  const statusCode = error.data?.statusCode

  return { name: error.name, message, statusCode }
}

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
