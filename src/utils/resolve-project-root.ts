import type { ForgeClient } from '../client/port'
import type { Logger } from '../types'

/**
 * Resolves the real project directory for a loop from its host session.
 *
 * Loops are launched from a session rooted at the real project directory, but
 * the plugin instance that handles the `loop()` tool call may be bound to a
 * worktree directory (forge worktrees live under `<dataDir>/worktrees/...`).
 * Persisting that worktree path as `projectDir` makes the dashboard group and
 * label loops by the worktree instead of the originating project. The host
 * session's own `directory` is the authoritative project root, so we resolve it
 * directly via the session API.
 *
 * Returns `null` when no host session id is available or the lookup fails, so
 * callers can fall back to a sensible default.
 */
export async function resolveHostSessionDirectory(
  client: ForgeClient,
  hostSessionId: string | undefined,
  fallbackDirectory: string,
  logger?: Logger,
): Promise<string | null> {
  if (!hostSessionId) return null

  type SessionGetInput = Parameters<typeof client.session.get>[0]

  const attempts: SessionGetInput[] = [
    { sessionID: hostSessionId } as SessionGetInput,
    { sessionID: hostSessionId, directory: fallbackDirectory } as SessionGetInput,
  ]

  for (const input of attempts) {
    try {
      const session = await client.session.get(input)
      const dir = session?.directory
      if (dir) return dir
    } catch {
      // fall through to next attempt
    }
  }

  logger?.log(`resolveHostSessionDirectory: could not resolve directory for host session ${hostSessionId}`)
  return null
}
