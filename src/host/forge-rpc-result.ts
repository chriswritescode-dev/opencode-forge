import { z } from 'zod'

export type ForgeRpcError = { error: string }

export type ForgeRpcResult<T> = T | ForgeRpcError

const errorEnvelopeSchema = z.object({ error: z.string() })

export function readForgeRpcResult<P, T>(
  payload: P,
  label: string,
  read: (payload: P) => T | ForgeRpcError | null,
): ForgeRpcResult<T> {
  const envelope = errorEnvelopeSchema.safeParse(payload)
  if (envelope.success) return envelope.data
  return read(payload) ?? { error: `Forge returned an invalid ${label}` }
}
