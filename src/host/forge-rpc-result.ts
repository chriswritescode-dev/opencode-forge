import { isRecord } from '../utils/is-record'

export type ForgeRpcError = { error: string }

/** Envelope every TUI-side reader returns: a validated result or a server-reported error. */
export type ForgeRpcResult<T> = T | ForgeRpcError

/**
 * Shared envelope handling for the TUI-side Forge RPC readers. A non-record payload
 * and a `null` from `parse` both become the same invalid-result error, while a
 * server-reported `{ error }` passes through unchanged.
 */
export function readForgeRpcResult<T>(
  value: unknown,
  label: string,
  parse: (record: Record<string, unknown>) => T | ForgeRpcError | null,
): ForgeRpcResult<T> {
  if (!isRecord(value)) return { error: `Forge returned an invalid ${label}` }
  if (typeof value.error === 'string') return { error: value.error }
  return parse(value) ?? { error: `Forge returned an invalid ${label}` }
}
