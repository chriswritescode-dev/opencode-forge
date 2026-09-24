import type { Database } from 'bun:sqlite'
import { createLoopsRepo, createPlanAmendmentsRepo, createPlansRepo } from '../storage'
import { parseModelString } from '../utils/model-fallback'
import { collectDashboardData } from './data'
import { diffAmendmentSnapshots } from './amendment-diff'
import { renderDashboardHtml } from './render'
import { isLoopbackHost } from './config'

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface DashboardDeps {
  forgeDb: Database
  /**
   * Whether the dashboard's mutating routes (`POST /api/loop/models`,
   * `POST /api/plan/delete`) are allowed. Set only for a loopback bind: the
   * dashboard has no auth, so a reachable bind must not change the loop's models
   * or delete plans.
   */
  allowSend?: boolean
}

// ---------------------------------------------------------------------------
// Mutating-route helpers
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isValidHostPort(raw: string): boolean {
  if (!/^[1-9]\d{0,4}$/.test(raw)) return false
  return Number(raw) <= 65535
}

function isLoopbackHostHeader(host: string | null): boolean {
  if (host === null || host === '') return false
  if (/[\s,/@]/.test(host)) return false
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(host)
  if (bracketed) {
    if (bracketed[2] !== undefined && !isValidHostPort(bracketed[2])) return false
    return isLoopbackHost(bracketed[1])
  }
  const unbracketed = /^([^:]+)(?::(\d+))?$/.exec(host)
  if (!unbracketed) return false
  if (unbracketed[2] !== undefined && !isValidHostPort(unbracketed[2])) return false
  return isLoopbackHost(unbracketed[1])
}

/** Variants are opaque keys from the provider catalogue; keep them token-shaped. */
const VARIANT_PATTERN = /^[\w.:-]{1,64}$/

type ModelFieldResult = { ok: true; value: string | null | undefined } | { ok: false; error: string }

/**
 * Read one role's model field. `undefined` leaves the role untouched, `null`
 * clears it back to the configured default, and a string must parse as
 * `provider/model`.
 */
function readModelField(raw: unknown, label: string): ModelFieldResult {
  if (raw === undefined) return { ok: true, value: undefined }
  if (raw === null || raw === '') return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string, null, or omitted.` }
  if (!parseModelString(raw)) {
    return { ok: false, error: `${label} must look like "provider/model" (got ${JSON.stringify(raw)}).` }
  }
  return { ok: true, value: raw }
}

function readVariantField(raw: unknown, label: string): ModelFieldResult {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string or null.` }
  if (!VARIANT_PATTERN.test(raw)) return { ok: false, error: `${label} is not a valid variant key.` }
  return { ok: true, value: raw }
}

type JsonBodyResult =
  | { ok: true; record: Record<string, unknown> }
  | { ok: false; response: Response }

/**
 * Reads a JSON object body for a mutating route.
 *
 * Requiring `application/json` is what keeps a loopback dashboard safe from a
 * page in the user's browser: form-encodable content types are sent
 * cross-origin without a preflight, and a `text/plain` form body can be shaped
 * into valid JSON, so a parse-anything handler would accept it.
 */
async function readJsonRecord(req: Request): Promise<JsonBodyResult> {
  const mediaType = req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    return {
      ok: false,
      response: new Response('content-type must be application/json.', { status: 415 }),
    }
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return {
      ok: false,
      response: new Response('Request body must be valid JSON.', { status: 400 }),
    }
  }
  return { ok: true, record: (body ?? {}) as Record<string, unknown> }
}

export function createRequestHandler(deps: DashboardDeps): (req: Request) => Promise<Response> {
  const html = renderDashboardHtml()
  const allowSend = deps.allowSend ?? false
  const loopsRepo = createLoopsRepo(deps.forgeDb)
  const plansRepo = createPlansRepo(deps.forgeDb)
  let amendmentsRepo: ReturnType<typeof createPlanAmendmentsRepo> | null = null
  try {
    amendmentsRepo = createPlanAmendmentsRepo(deps.forgeDb)
  } catch {
    amendmentsRepo = null
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const pathname = url.pathname

    if (pathname === '/api/loop/models') {
      if (req.method !== 'POST') return new Response('Not found', { status: 404 })
      if (!allowSend || !isLoopbackHostHeader(req.headers.get('host'))) {
        return new Response(
          'Changing models is disabled: the dashboard must be reached via a loopback address and ' +
          'has no authentication. Open it via localhost to change models.',
          { status: 403 },
        )
      }
      const parsed = await readJsonRecord(req)
      if (!parsed.ok) return parsed.response
      const record = parsed.record
      const projectId = typeof record.projectId === 'string' ? record.projectId : null
      const loopName = typeof record.loopName === 'string' ? record.loopName : null
      if (!projectId || !loopName) {
        return new Response('projectId and loopName are required.', { status: 400 })
      }
      const loop = loopsRepo.get(projectId, loopName)
      if (!loop) return new Response('Loop not found.', { status: 404 })

      const executionModel = readModelField(record.executionModel, 'executionModel')
      if (!executionModel.ok) return new Response(executionModel.error, { status: 400 })
      const auditorModel = readModelField(record.auditorModel, 'auditorModel')
      if (!auditorModel.ok) return new Response(auditorModel.error, { status: 400 })
      const executionVariant = readVariantField(record.executionVariant, 'executionVariant')
      if (!executionVariant.ok) return new Response(executionVariant.error, { status: 400 })
      const auditorVariant = readVariantField(record.auditorVariant, 'auditorVariant')
      if (!auditorVariant.ok) return new Response(auditorVariant.error, { status: 400 })
      if (executionModel.value === undefined && auditorModel.value === undefined) {
        return new Response('Provide executionModel and/or auditorModel.', { status: 400 })
      }

      try {
        loopsRepo.setModels(projectId, loopName, {
          ...(executionModel.value !== undefined
            ? { executionModel: executionModel.value, executionVariant: executionVariant.value ?? null }
            : {}),
          ...(auditorModel.value !== undefined
            ? { auditorModel: auditorModel.value, auditorVariant: auditorVariant.value ?? null }
            : {}),
        })

        const updated = loopsRepo.get(projectId, loopName)
        if (!updated) return new Response('Loop not found.', { status: 404 })

        return new Response(JSON.stringify({
          ok: true,
          executionModel: updated.executionModel ?? null,
          executionVariant: updated.executionVariant ?? null,
          auditorModel: updated.auditorModel ?? null,
          auditorVariant: updated.auditorVariant ?? null,
        }), {
          headers: { 'content-type': 'application/json; charset=utf-8' },
        })
      } catch (err) {
        return new Response(`Could not update loop models: ${errorMessage(err)}`, { status: 500 })
      }
    }

    if (pathname === '/api/plan/delete') {
      if (req.method !== 'POST') return new Response('Not found', { status: 404 })
      if (!allowSend || !isLoopbackHostHeader(req.headers.get('host'))) {
        return new Response(
          'Deleting plans is disabled: the dashboard must be reached via a loopback address and has ' +
          'no authentication. Open it via localhost to delete plans.',
          { status: 403 },
        )
      }
      const parsed = await readJsonRecord(req)
      if (!parsed.ok) return parsed.response
      const record = parsed.record
      const projectId = typeof record.projectId === 'string' ? record.projectId : ''
      const sessionId = typeof record.sessionId === 'string' ? record.sessionId : ''
      if (!projectId || !sessionId) {
        return new Response('projectId and sessionId are required.', { status: 400 })
      }
      if (!plansRepo.deleteForSession(projectId, sessionId)) {
        return new Response('Plan not found.', { status: 404 })
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }

    if (req.method !== 'GET') {
      return new Response('Not found', { status: 404 })
    }

    if (pathname === '/') {
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }

    if (pathname === '/api/data') {
      const data = collectDashboardData(deps.forgeDb, {
        projectId: url.searchParams.get('project'),
        loopName: url.searchParams.get('loop'),
      })
      return new Response(JSON.stringify(data), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      })
    }

    if (pathname === '/api/plan') {
      const project = url.searchParams.get('project')
      const session = url.searchParams.get('session')
      if (!project || !session) {
        return new Response('project and session are required.', { status: 400 })
      }
      const row = plansRepo.getForSession(project, session)
      if (!row) {
        return new Response('Plan not found.', { status: 404 })
      }
      return new Response(JSON.stringify({ sessionId: row.sessionId, updatedAt: row.updatedAt, content: row.content }), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      })
    }

    if (pathname === '/api/amendment') {
      const project = url.searchParams.get('project')
      const loop = url.searchParams.get('loop')
      const rawId = url.searchParams.get('id')
      if (!project || !loop || rawId === null || !/^\d+$/.test(rawId)) {
        return new Response('project, loop and a numeric id are required.', { status: 400 })
      }
      const id = Number(rawId)
      if (!Number.isSafeInteger(id)) {
        return new Response('project, loop and a numeric id are required.', { status: 400 })
      }
      if (!amendmentsRepo) {
        return new Response('Amendment not found.', { status: 404 })
      }
      const row = amendmentsRepo.get(project, loop, id)
      if (!row) {
        return new Response('Amendment not found.', { status: 404 })
      }
      return new Response(JSON.stringify(diffAmendmentSnapshots(row.sectionsBefore, row.sectionsAfter)), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      })
    }

    return new Response('Not found', { status: 404 })
  }
}
