/**
 * Stable djb2-xor hash of plan text, used for dedupe/idempotency keys across
 * plan capture, execution, and approval flows. Returns a base36 string.
 */
export function hashPlanText(planText: string): string {
  let hash = 5381
  for (let i = 0; i < planText.length; i += 1) {
    hash = ((hash << 5) + hash) ^ planText.charCodeAt(i)
  }
  return (hash >>> 0).toString(36)
}
