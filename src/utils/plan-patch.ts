/**
 * Shared plan patching logic used by API handlers.
 */

export interface PlanPatchResult {
  success: boolean
  updated?: string
  error?: string
}

export function applyPlanPatch(
  existing: string,
  oldString: string,
  newString: string
): PlanPatchResult {
  const occurrences = existing.split(oldString).length - 1

  if (occurrences === 0) {
    return { success: false, error: 'old_string not found in plan' }
  }

  if (occurrences > 1) {
    return {
      success: false,
      error: `old_string found ${occurrences} times - must be unique`,
    }
  }

  const updated = existing.replace(oldString, newString)
  return { success: true, updated }
}
