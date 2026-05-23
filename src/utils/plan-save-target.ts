import { savePlanToArchive, DEFAULT_PLAN_ARCHIVE_TTL_MS } from './plan-archive'

export type PlanSaveOutcome =
  | { kind: 'session'; ok: boolean }
  | { kind: 'archive'; ok: true; deduped: boolean; filepath: string; filename: string }
  | { kind: 'archive'; ok: false; error: Error }
  | { kind: 'noop'; reason: 'missing-project' }

export interface SavePlanFromDialogArgs {
  sessionId: string | undefined
  projectId: string | undefined
  text: string
  ttlMs?: number
  writeSession: (sessionId: string, text: string) => Promise<boolean>
  now?: Date
}

export async function savePlanFromDialog(args: SavePlanFromDialogArgs): Promise<PlanSaveOutcome> {
  const { sessionId, projectId, text, writeSession } = args
  if (sessionId) {
    const ok = await writeSession(sessionId, text)
    return { kind: 'session', ok }
  }
  if (!projectId) return { kind: 'noop', reason: 'missing-project' }
  try {
    const { deduped, filepath, filename } = savePlanToArchive(
      projectId,
      text,
      args.now ?? new Date(),
      args.ttlMs ?? DEFAULT_PLAN_ARCHIVE_TTL_MS,
    )
    return { kind: 'archive', ok: true, deduped, filepath, filename }
  } catch (err) {
    return { kind: 'archive', ok: false, error: err as Error }
  }
}
