import type { Plugin } from '@opencode/plugin/tui'
import { existsSync } from 'fs'
import { forgeWorktreesRoot, isForgeWorktreeDir } from '../workspace/forge-naming'

const SESSION_LIST_PAGE_SIZE = 100

export function readForgeSessionDelete(data: Readonly<Record<string, unknown>>): string | null {
  return typeof data.sessionID === 'string' && data.sessionID.length > 0 ? data.sessionID : null
}

export async function removeSessionBestEffort(context: Plugin.Context, sessionID: string): Promise<void> {
  try {
    await context.client.session.remove({ sessionID })
  } catch (err) {
    console.error(`[forge] failed to delete session ${sessionID}`, err)
  }
}

async function listOrphanedLoopSessionIds(
  context: Plugin.Context,
  projectId: string,
  dataDir: string,
  signal: AbortSignal,
): Promise<string[]> {
  if (!existsSync(forgeWorktreesRoot(dataDir))) return []
  const orphaned: string[] = []
  let cursor: string | undefined
  while (!signal.aborted) {
    const page = await context.client.session.list(
      cursor ? { cursor } : { project: projectId, limit: SESSION_LIST_PAGE_SIZE },
    )
    for (const session of page.data) {
      const directory = session.location.directory
      if (isForgeWorktreeDir(dataDir, directory) && !existsSync(directory)) orphaned.push(session.id)
    }
    const next = page.cursor.next ?? undefined
    if (page.data.length < SESSION_LIST_PAGE_SIZE || !next) break
    cursor = next
  }
  return orphaned
}

export async function removeOrphanedLoopSessions(
  context: Plugin.Context,
  projectId: string,
  dataDir: string,
  signal: AbortSignal,
): Promise<number> {
  const orphaned = await listOrphanedLoopSessionIds(context, projectId, dataDir, signal)
  for (const sessionID of orphaned) {
    if (signal.aborted) break
    await removeSessionBestEffort(context, sessionID)
  }
  return orphaned.length
}
