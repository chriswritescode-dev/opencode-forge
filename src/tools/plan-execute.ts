import { tool } from '@opencode-ai/plugin'
import type { ToolContext } from './types'
import { createForgeExecutionService, type ForgeExecutionRequestContext, type PlanSource } from '../services/execution'
import { captureLatestPlanForSession } from '../services/plan-capture'
import { formatPlanSessionTitle } from '../utils/session-titles'

const z = tool.schema

export function createPlanExecuteTools(ctx: ToolContext): Record<string, ReturnType<typeof tool>> {
  const { directory, config, logger, v2, plansRepo, projectId } = ctx

  return {
    'plan-execute': tool({
      description: 'Send the plan to the Code agent for execution. By default creates a new session. Set inPlace to true to switch to the code agent in the current session (plan is already in context).',
      args: {
        plan: z.string().optional().describe('The full implementation plan. If omitted, reads from the session plan store.'),
        title: z.string().describe('Short title for the session (shown in session list)'),
        inPlace: z.boolean().optional().default(false).describe('Execute in the current session, instead of creating a new session'),
      },
      execute: async (args, context) => {
        logger.log(`plan-execute: ${args.inPlace ? 'switching to code agent' : 'creating session'} titled "${args.title}"`)

        let source: PlanSource
        if (!args.plan) {
          const capture = await captureLatestPlanForSession(
            {
              v2,
              plansRepo,
              projectId,
              directory,
              logger,
            },
            context.sessionID
          )
          
          if (capture.status === 'captured' || capture.status === 'already-current') {
            source = { kind: 'stored', sessionId: context.sessionID }
          } else {
            const planRow = plansRepo.getForSession(projectId, context.sessionID)
            if (!planRow) {
              return 'No plan found. Ensure the final plan is wrapped with <!-- forge-plan:start --> and <!-- forge-plan:end --> markers, or pass it directly as the plan argument.'
            }
            source = { kind: 'stored', sessionId: context.sessionID }
          }
        } else {
          source = { kind: 'inline', planText: args.plan }
        }

        const sessionTitle = formatPlanSessionTitle(args.title)
        const executionModel = config.executionModel

        // Build execution request context
        const execCtx: ForgeExecutionRequestContext = {
          surface: 'tool',
          projectId,
          directory,
          sourceSessionId: context.sessionID,
        }

        // Create execution service
        const service = createForgeExecutionService({
          projectId,
          directory,
          config,
          logger,
          dataDir: ctx.dataDir,
          v2,
          legacyClient: ctx.input?.client,
          plansRepo,
          loopsRepo: ctx.loopsRepo,
          graphStatusRepo: ctx.graphStatusRepo,
          loopService: ctx.loopService,
          loopHandler: ctx.loopHandler,
          sandboxManager: ctx.sandboxManager,
        })

        if (args.inPlace) {
          // Execute-here mode
          const result = await service.dispatch(execCtx, {
            type: 'plan.execute.here',
            source,
            targetSessionId: context.sessionID,
            executionModel,
            title: sessionTitle,
          })

          if (!result.ok) {
            logger.error(`plan-execute: in-place execution failed`, result.error)
            return `Failed to switch to code agent. Error: ${result.error.message}`
          }

          const modelInfo = result.data.modelUsed ?? 'default'
          return `Switching to code agent for execution.\n\nTitle: ${sessionTitle}\nModel: ${modelInfo}\nAgent: code`
        }

        // New session mode
        const result = await service.dispatch(execCtx, {
          type: 'plan.execute.newSession',
          source,
          executionModel,
          title: sessionTitle,
          lifecycle: {
            selectSession: true,
          },
        })

        if (!result.ok) {
          logger.error(`plan-execute: failed to create session`, result.error)
          return 'Failed to create new session.'
        }

        const modelInfo = result.data.modelUsed ?? 'default'
        return `Implementation session created and plan sent.\n\nSession: ${result.data.sessionId}\nTitle: ${sessionTitle}\nModel: ${modelInfo}\n\nNavigated to the new session. You can change the model from the session dropdown.`
      },
    }),
  }
}
