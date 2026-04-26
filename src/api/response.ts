import { ApiError } from './errors'

interface SuccessEnvelope<T> {
  ok: true
  data: T
}

interface ErrorEnvelope {
  ok: false
  error: {
    code: string
    message: string
  }
}

export function json<T>(status: number, body: T): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}

export function ok<T>(data: T, status = 200): Response {
  return json<SuccessEnvelope<T>>(status, { ok: true, data })
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return json<ErrorEnvelope>(err.status, {
      ok: false,
      error: {
        code: err.code,
        message: err.message,
      },
    })
  }

  if (err instanceof Error) {
    return json<ErrorEnvelope>(500, {
      ok: false,
      error: {
        code: 'internal_error',
        message: err.message,
      },
    })
  }

  return json<ErrorEnvelope>(500, {
    ok: false,
    error: {
      code: 'internal_error',
      message: 'unknown error',
    },
  })
}
