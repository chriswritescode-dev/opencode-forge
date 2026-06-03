import type { Database } from 'bun:sqlite'
import { collectDashboardData } from './data'
import { renderDashboardHtml } from './render'

export function createRequestHandler(db: Database): (req: Request) => Response {
  const html = renderDashboardHtml()
  return (req: Request): Response => {
    if (req.method !== 'GET') {
      return new Response('Not found', { status: 404 })
    }
    const url = new URL(req.url)
    if (url.pathname === '/') {
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
    if (url.pathname === '/api/data') {
      const data = collectDashboardData(db)
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
