import type { Logger } from '../types'
import type { createOpencodeClient as createV2Client } from '@opencode-ai/sdk/v2'
import {
  decodeRequest,
  encodeReply,
  ForgeRpcError,
} from './bus-protocol'
import type { ApiDeps, Handler } from './types'
import type { ProjectRegistry } from './project-registry'
import { ZodError } from 'zod'

import { handleGetSessionPlan } from './handlers/plans'
import { handleGetLoopPlan } from './handlers/plans'
import { handleWriteSessionPlan } from './handlers/plans'
import { handleWriteLoopPlan } from './handlers/plans'
import { handlePatchSessionPlan } from './handlers/plans'
import { handleDeleteSessionPlan } from './handlers/plans'
import { handleDeleteLoopPlan } from './handlers/plans'
import { handleExecutePlan } from './handlers/plan-execute'
import { handleListLoops } from './handlers/loops'
import { handleGetLoop } from './handlers/loops'
import { handleStartLoop } from './handlers/loops'
import { handleCancelLoop } from './handlers/loops'
import { handleRestartLoop } from './handlers/loops'
import { handleListModels } from './handlers/models'
import { handleGetModelPreferences } from './handlers/models'
import { handleWriteModelPreferences } from './handlers/models'
import { handleListFindings } from './handlers/findings'
import { handleWriteFinding } from './handlers/findings'
import { handleDeleteFinding } from './handlers/findings'
import { handleListProjects } from './handlers/projects'
import { handleGetProject } from './handlers/projects'
import { handleGetGraphStatus } from './handlers/projects'

const HANDLERS = new Map<string, Handler>([
  ['plan.read.session', handleGetSessionPlan],
  ['plan.read.loop', handleGetLoopPlan],
  ['plan.write.session', handleWriteSessionPlan],
  ['plan.write.loop', handleWriteLoopPlan],
  ['plan.patch.session', handlePatchSessionPlan],
  ['plan.delete.session', handleDeleteSessionPlan],
  ['plan.delete.loop', handleDeleteLoopPlan],
  ['plan.execute', handleExecutePlan],
  ['loops.list', handleListLoops],
  ['loops.get', handleGetLoop],
  ['loops.start', handleStartLoop],
  ['loops.cancel', handleCancelLoop],
  ['loops.restart', handleRestartLoop],
  ['models.list', handleListModels],
  ['models.prefs.read', handleGetModelPreferences],
  ['models.prefs.write', handleWriteModelPreferences],
  ['findings.list', handleListFindings],
  ['findings.write', handleWriteFinding],
  ['findings.delete', handleDeleteFinding],
  ['projects.list', handleListProjects],
  ['projects.get', handleGetProject],
  ['graph.status', handleGetGraphStatus],
])

export interface BusRpcDeps {
  registry: ProjectRegistry
  logger: Logger
  v2: ReturnType<typeof createV2Client>
  instanceDirectory: string
}

export function createBusRpcEventHook(deps: BusRpcDeps) {
  const { registry, logger, v2, instanceDirectory } = deps

  return async (input: {
    event: {
      type: string
      properties?: Record<string, unknown>
    }
  }): Promise<void> => {
    const { event } = input

    // Fast-return if not a tui.command.execute event
    if (event.type !== 'tui.command.execute') {
      return
    }

    const command = event.properties?.command as string | undefined
    if (!command) {
      return
    }

    const req = decodeRequest(command)
    if (!req) {
      return
    }

    // Extract request fields first
    const { verb, rid, params, body } = req
    const eventDirectory = event.properties?.directory as string | undefined
    
    // Resolve target context: prefer projectId from request, then fall back to directory matching
    // This ensures requests with explicit projectId are routed correctly even if directory differs
    let targetCtx = null
    
    // First, try to resolve by projectId if provided in the request
    if (req.projectId) {
      targetCtx = registry.get(req.projectId)
      
      // If projectId was provided but not found, silently ignore
      // This request might be for a different forge instance
      if (!targetCtx) {
        return
      }
    }
    
    // If no projectId, fall back to directory matching
    if (!targetCtx) {
      const requestDirectory = req.directory || eventDirectory || instanceDirectory
      if (requestDirectory !== instanceDirectory) {
        // This request is for a different forge instance - silently ignore
        return
      }
      targetCtx = registry.findByDirectory(instanceDirectory)
    }
    
    if (!targetCtx) {
      // No matching project found - this should not happen as instanceDirectory should always have a context
      logger.error(`[bus-rpc] no ToolContext found for instance directory: ${instanceDirectory}`)
      return
    }

    const handler = HANDLERS.get(verb)
    if (!handler) {
      logger.log(`[bus-rpc] unknown verb: ${verb}`)
      
      const reply = {
        rid,
        status: 'err' as const,
        code: 'bad_request',
        message: `unknown verb: ${verb}`,
      }

      await v2.tui.publish({
        directory: targetCtx.directory,
        body: {
          type: 'tui.command.execute',
          properties: {
            command: encodeReply(reply),
          },
        },
      })
      return
    }

    const apiDeps: ApiDeps = {
      ctx: targetCtx,
      logger: targetCtx.logger,
      projectId: targetCtx.projectId,
    }

    // Merge projectId into params for handlers that expect it
    const paramsWithProjectId = { ...params, projectId: targetCtx.projectId }

    try {
      const result = await handler(apiDeps, paramsWithProjectId, body)

      const reply = {
        rid,
        status: 'ok' as const,
        data: result,
      }

      await v2.tui.publish({
        directory: targetCtx.directory,
        body: {
          type: 'tui.command.execute',
          properties: {
            command: encodeReply(reply),
          },
        },
      })
    } catch (err) {
      if (err instanceof ForgeRpcError) {
        const reply = {
          rid,
          status: 'err' as const,
          code: err.code,
          message: err.message,
        }

        await v2.tui.publish({
          directory: targetCtx.directory,
          body: {
            type: 'tui.command.execute',
            properties: {
              command: encodeReply(reply),
            },
          },
        })
      } else {
        // Check if this is a Zod validation error - treat as bad_request
        const isZodError = err instanceof ZodError || (err instanceof Error && err.name === 'ZodError')
        const code = isZodError ? 'bad_request' : 'internal'
        const message = err instanceof Error ? err.message : String(err)
        
        if (!isZodError) {
          logger.error(`[bus-rpc] handler error for ${verb}`, err)
        }

        const reply = {
          rid,
          status: 'err' as const,
          code,
          message,
        }

        await v2.tui.publish({
          directory: targetCtx.directory,
          body: {
            type: 'tui.command.execute',
            properties: {
              command: encodeReply(reply),
            },
          },
        })
      }
    }
  }
}
