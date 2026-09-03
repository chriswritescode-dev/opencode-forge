/**
 * Shared response construction for the Forge execution command bus.
 *
 * `ok`/`fail` builders plus the response/error/warning shapes, in one module
 * so command handlers (e.g. the restart handler in execution.ts and the
 * migration handler in loop-migration.ts) cannot drift in error construction.
 */

export interface ForgeExecutionError {
  code: 'bad_request' | 'not_found' | 'conflict' | 'disabled' | 'prompt_failed' | 'lifecycle_failed' | 'internal_error' | 'provider_limit'
  status: number
  message: string
  candidates?: string[]
  details?: Record<string, unknown>
}

export interface ForgeExecutionWarning {
  code: string
  message: string
}

export type ForgeExecutionResponse<T> =
  | { ok: true; data: T; warnings?: ForgeExecutionWarning[] }
  | { ok: false; error: ForgeExecutionError }

export function ok<T>(data: T, warnings?: ForgeExecutionWarning[]): ForgeExecutionResponse<T> {
  return { ok: true, data, warnings }
}

export function fail(
  code: ForgeExecutionError['code'],
  status: number,
  message: string,
  details?: Record<string, unknown>,
  candidates?: string[],
): ForgeExecutionResponse<never> {
  return {
    ok: false,
    error: { code, status, message, details, candidates }
  }
}
