import type { ToolContext } from '../tools/types'
import type { Logger } from '../types'

export interface ApiDeps {
  ctx: ToolContext
  logger: Logger
  projectId: string
}

export interface RouteMatch {
  handler: RouteHandler
  params: Record<string, string>
}

export type RouteHandler = (
  req: Request,
  deps: ApiDeps,
  params: Record<string, string>
) => Promise<Response>
