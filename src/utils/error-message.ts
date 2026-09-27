/**
 * The message of a thrown value: an `Error`'s `message`, or `String(err)` for
 * anything else. Shared so every caller renders a failure the same way.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
