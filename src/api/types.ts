import type { ToolContext } from '../tools/types'
import type { Logger } from '../types'
import type { ProjectRegistry } from './project-registry'

export interface ApiDeps {
  ctx: ToolContext
  logger: Logger
  projectId: string
  registry: ProjectRegistry
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
