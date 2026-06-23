/**
 * Type guard that narrows an unknown value to a plain object
 * (`Record<string, unknown>`).
 *
 * Returns `true` when `value` is a non-null, non-array object (i.e. a
 * dictionary-like structure), and `false` for primitives, arrays, and `null`.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
