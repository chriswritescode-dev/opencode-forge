import type { ToolContext } from '../tools/types'
import type { Logger } from '../types'
import type { ProjectRegistry } from './project-registry'
import type { ApiRegistryRepo } from '../storage'

export interface ApiDeps {
  ctx: ToolContext
  logger: Logger
  projectId: string
  registry: ProjectRegistry
  apiRegistryRepo: ApiRegistryRepo
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
