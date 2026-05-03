import type { Logger } from '../types'
import type { createOpencodeClient as createV2Client } from '@opencode-ai/sdk/v2'
import {
  decodeRequest,
  encodeReply,
  encodeEvent,
  ForgeRpcError,
  type ForgeRpcReply,
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
])

export interface BusRpcDeps {
  registry: ProjectRegistry
  logger: Logger
  v2: ReturnType<typeof createV2Client>
  instanceDirectory: string
}

export function createBusRpcEventHook(deps: BusRpcDeps) {
  const { registry, logger, v2, instanceDirectory } = deps

  function publishReply(directory: string, verb: string, reply: ForgeRpcReply): void {
    logger.debug(`[bus-rpc] reply scheduled ${verb} rid=${reply.rid} directory=${directory} status=${reply.status}`)
    setTimeout(() => {
      v2.tui.publish({
        directory,
        body: {
          type: 'tui.command.execute',
          properties: {
            command: encodeReply(reply),
          },
        },
      }).then(() => {
        logger.debug(`[bus-rpc] reply published ${verb} rid=${reply.rid} directory=${directory} status=${reply.status}`)
      }).catch((err) => {
        logger.error(`[bus-rpc] reply publish failed for ${verb} rid=${reply.rid}`, err)
      })
    }, 0)
  }

  function publishEvent(directory: string, name: string, rid: string, data: unknown): void {
    logger.debug(`[bus-rpc] event scheduled name=${name} rid=${rid} directory=${directory}`)
    setTimeout(() => {
      v2.tui.publish({
        directory,
        body: {
          type: 'tui.command.execute',
          properties: {
            command: encodeEvent({ name, directory, payload: { rid, data } }),
          },
        },
      }).then(() => {
        logger.debug(`[bus-rpc] event published name=${name} rid=${rid} directory=${directory}`)
      }).catch((err) => {
        logger.error(`[bus-rpc] event publish failed for name=${name} rid=${rid}`, err)
      })
    }, 0)
  }

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

    const { verb, rid, params, body } = req
    const eventDirectory = event.properties?.directory as string | undefined
    const explicitDirectory = req.directory || eventDirectory
    const requestDirectory = explicitDirectory || instanceDirectory
    logger.debug(`[bus-rpc] request ${verb} rid=${rid} directory=${requestDirectory} projectId=${req.projectId ?? 'none'}`)

    let targetCtx = explicitDirectory ? registry.findByDirectory(requestDirectory) : null
    if (req.projectId) {
      targetCtx = targetCtx ?? registry.get(req.projectId)
      if (!targetCtx && !explicitDirectory) {
        return
      }
    }
    targetCtx = targetCtx
      ?? registry.findByDirectory(instanceDirectory)
      ?? registry.list()[0]
      ?? null
    
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

      publishReply(requestDirectory, verb, reply)
      return
    }

    const effectiveProjectId = req.projectId || targetCtx.projectId
    const effectiveCtx = verb !== 'projects.list' && requestDirectory && requestDirectory !== targetCtx.directory
      ? { ...targetCtx, projectId: effectiveProjectId, directory: requestDirectory }
      : targetCtx

    const apiDeps: ApiDeps = {
      ctx: effectiveCtx,
      logger: targetCtx.logger,
      projectId: effectiveProjectId,
      eventPublisher: (name: string, data: unknown) => {
        publishEvent(requestDirectory, name, rid, data)
      },
    }

    // Merge projectId into params for handlers that expect it
    const paramsWithProjectId = { ...params, projectId: effectiveProjectId }

    try {
      const result = await handler(apiDeps, paramsWithProjectId, body)

      const reply = {
        rid,
        status: 'ok' as const,
        data: result,
      }

      publishReply(requestDirectory, verb, reply)
    } catch (err) {
      if (err instanceof ForgeRpcError) {
        const reply = {
          rid,
          status: 'err' as const,
          code: err.code,
          message: err.message,
        }

        publishReply(requestDirectory, verb, reply)
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

        publishReply(requestDirectory, verb, reply)
      }
    }
  }
}
