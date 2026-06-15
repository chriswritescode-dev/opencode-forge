import type { ForgeClient } from '../client/port'

export type TuiWorkspaceEntry = {
  id: string
  name: string
  type: string
  branch?: string | undefined
  directory?: string | undefined
  timeUsed?: number | undefined
}

type WorkspaceStatusEntry = {
  workspaceID: string
  status: string
}

export async function listConnectedWorkspaces(workspace: ForgeClient['workspace']): Promise<TuiWorkspaceEntry[]> {
  // syncList is a best-effort sync trigger only.
  try {
    await workspace.syncList()
  } catch {
    // swallow
  }

  let rawEntries: TuiWorkspaceEntry[]
  try {
    rawEntries = (await workspace.list()) as unknown as TuiWorkspaceEntry[]
  } catch {
    return []
  }

  let statusMap: Record<string, string> = {}
  try {
    const entries = (await workspace.status()) as unknown as WorkspaceStatusEntry[]
    statusMap = Object.fromEntries(entries.map((s) => [s.workspaceID, s.status]))
  } catch {
    // ignore status errors
  }

  const filtered = rawEntries.filter((w) => {
    const status = statusMap[w.id]
    return !status || status === 'connected'
  })

  filtered.sort((a, b) => {
    const ta = Number(a.timeUsed ?? 0)
    const tb = Number(b.timeUsed ?? 0)
    return tb - ta
  })

  return filtered
}
