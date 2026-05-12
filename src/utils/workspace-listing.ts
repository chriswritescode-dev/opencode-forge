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

export type WorkspaceListApi = {
  list?: () => Promise<{ data?: unknown[] }>
  status?: () => Promise<{ data?: unknown[] }>
  syncList?: () => Promise<unknown>
}

export async function listConnectedWorkspaces(workspaceApi: WorkspaceListApi | undefined): Promise<TuiWorkspaceEntry[]> {
  if (!workspaceApi || typeof workspaceApi.list !== 'function') return []

  if (typeof workspaceApi.syncList === 'function') {
    try {
      await workspaceApi.syncList()
    } catch {
      // swallow — syncList is a best-effort trigger only
    }
  }

  const rawEntries: TuiWorkspaceEntry[] = ((await workspaceApi.list()).data ?? []) as TuiWorkspaceEntry[]

  let statusMap: Record<string, string> = {}
  if (typeof workspaceApi.status === 'function') {
    try {
      const statusResult = await workspaceApi.status()
      const entries = (statusResult.data ?? []) as WorkspaceStatusEntry[]
      statusMap = Object.fromEntries(entries.map((s) => [s.workspaceID, s.status]))
    } catch {
      // ignore status errors
    }
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
