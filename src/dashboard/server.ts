import type { Database } from 'bun:sqlite'
import { collectDashboardData } from './data'
import { renderDashboardHtml } from './render'

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface DashboardDeps {
  forgeDb: Database
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
      const data = collectDashboardData(deps.forgeDb)
      return new Response(JSON.stringify(data), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      })
    }

    return new Response('Not found', { status: 404 })
  }
}
