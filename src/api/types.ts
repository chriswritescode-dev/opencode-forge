import type { ToolContext } from '../tools/types'
import type { Logger } from '../types'

export interface ApiDeps {
  ctx: ToolContext
  logger: Logger
  projectId: string
  eventPublisher?: (name: string, data: unknown) => void
}

export type Handler = (
  deps: ApiDeps,
  params: Record<string, string>,
  body: unknown
) => Promise<unknown>
