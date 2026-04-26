import type { RouteMatch, RouteHandler } from './types'

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  pattern: string // e.g. "/api/v1/projects/:projectId/plans/session/:sessionId"
  handler: RouteHandler
}

function patternToRegex(pattern: string): {
  regex: RegExp
  paramNames: string[]
} {
  const paramNames: string[] = []
  const regexStr = pattern.replace(/:(\w+)/g, (_, paramName) => {
    paramNames.push(paramName)
    return '([^/]+)'
  })
  const regex = new RegExp(`^${regexStr}$`)
  return { regex, paramNames }
}

export function match(
  routes: Route[],
  method: string,
  pathname: string
): RouteMatch | null {
  for (const route of routes) {
    if (route.method !== method) {
      continue
    }

    const { regex, paramNames } = patternToRegex(route.pattern)
    const match = pathname.match(regex)

    if (match) {
      const params: Record<string, string> = {}
      for (let i = 0; i < paramNames.length; i++) {
        params[paramNames[i]] = match[i + 1]
      }
      return {
        handler: route.handler,
        params,
      }
    }
  }

  return null
}
