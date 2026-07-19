import type { Database } from 'bun:sqlite'
import { collectDashboardData, collectDashboardLoopDetail, collectDashboardRunsPage } from './data'
import { renderDashboardHtml } from './render'

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface DashboardDeps {
  forgeDb: Database
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS })
}

function parseInteger(value: string | null, fallback: number): number | null {
  if (value === null) return fallback
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

// ---------------------------------------------------------------------------
// Request handler factory
// ---------------------------------------------------------------------------

export function createRequestHandler(deps: DashboardDeps): (req: Request) => Response {
  const html = renderDashboardHtml()
  return (req: Request): Response => {
    if (req.method !== 'GET') {
      return new Response('Not found', { status: 404 })
    }

    const url = new URL(req.url)
    const pathname = url.pathname

    if (pathname === '/') {
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }

    if (pathname === '/api/data') {
      return jsonResponse(collectDashboardData(deps.forgeDb))
    }

    if (pathname === '/api/loop-detail') {
      const projectId = url.searchParams.get('projectId')
      const loopName = url.searchParams.get('loopName')
      if (!projectId || !loopName) return jsonResponse({ error: 'Invalid loop parameters' }, 400)
      const detail = collectDashboardLoopDetail(deps.forgeDb, projectId, loopName)
      return detail ? jsonResponse(detail) : jsonResponse({ error: 'Loop not found' }, 404)
    }

    if (pathname === '/api/runs') {
      const projectParam = url.searchParams.get('projectId')
      const offset = parseInteger(url.searchParams.get('offset'), 0)
      const requestedLimit = parseInteger(url.searchParams.get('limit'), 50)
      if (projectParam === '' || offset === null || requestedLimit === null || requestedLimit < 1) {
        return jsonResponse({ error: 'Invalid runs parameters' }, 400)
      }
      const limit = Math.min(requestedLimit, 200)
      return jsonResponse(collectDashboardRunsPage(deps.forgeDb, {
        projectId: projectParam ?? undefined,
        offset,
        limit,
      }))
    }

    return new Response('Not found', { status: 404 })
  }
}
