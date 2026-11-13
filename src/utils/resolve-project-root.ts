import type { ForgeClient } from '../client/port'
import type { Logger } from '../types'

export async function resolveHostSessionDirectory(
  client: ForgeClient,
  hostSessionId: string | undefined,
  fallbackDirectory: string,
  logger?: Logger,
): Promise<string | null> {
  if (!hostSessionId) return null

  type SessionGetInput = Parameters<typeof client.session.get>[0]

  const attempts: SessionGetInput[] = [
    { sessionID: hostSessionId },
    { sessionID: hostSessionId, directory: fallbackDirectory },
  ]

  for (const input of attempts) {
    try {
      const session = await client.session.get(input)
      const dir = session?.directory
      if (dir) return dir
    } catch {
    }
  }

  logger?.log(`resolveHostSessionDirectory: could not resolve directory for host session ${hostSessionId}`)
  return null
}
