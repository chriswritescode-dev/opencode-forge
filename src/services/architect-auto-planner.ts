import type { ForgeClient } from '../client/port'
import type { PlansRepo } from '../storage/repos/plans-repo'
import type { Logger } from '../types'
import { parseModelString } from '../utils/model-fallback'
import { inspectArchitectPlanReadiness, type ArchitectPlanReadiness } from '../utils/architect-auto-output'
import { resolveSessionPlanOfRecord } from './plan-capture'
import { PLAN_CAPTURE_MESSAGE_LIMIT } from '../utils/marked-plan-parser'

/** Registered agent name the planner prompts; matches `architect-auto`'s displayName. */
export const ARCHITECT_AUTO_AGENT = 'architect-auto'

export interface ArchitectAutoSpawnInput {
  title: string
  prompt: string
  directory: string
  model?: string
  variant?: string
}

/** Dependencies the planner needs to spawn and inspect architect-auto planning sessions. */
export interface ArchitectAutoPlannerDeps {
  client: ForgeClient
  plansRepo: PlansRepo
  projectId: string
  logger: Logger
}

/**
 * Plans a single work item with the `architect-auto` agent inside a caller-chosen
 * worktree: spawn a session, read its newest assistant text, and resolve the
 * session's stored plan of record together with its structural readiness.
 */
export interface ArchitectAutoPlanner {
  /** Creates a session in `directory` and sends `prompt` to the architect-auto agent. */
  spawn(input: ArchitectAutoSpawnInput): Promise<{ sessionId: string }>
  /** Resolves the session's plan of record (resolveSessionPlanOfRecord) and checks it with inspectArchitectPlanReadiness. */
  capturePlan(sessionId: string, directory: string): Promise<ArchitectPlanReadiness>
  /** Newest assistant text part in the session, or null. */
  latestAssistantText(sessionId: string, directory: string): Promise<string | null>
}

const NO_STORED_PLAN_REASON = 'No stored plan found after capture'

/**
 * Builds an `ArchitectAutoPlanner` bound to one project. Every session is created
 * in the directory the caller passes, so a caller may plan inside any worktree.
 */
export function createArchitectAutoPlanner(deps: ArchitectAutoPlannerDeps): ArchitectAutoPlanner {
  const { client, plansRepo, projectId, logger } = deps

  async function spawn(input: ArchitectAutoSpawnInput): Promise<{ sessionId: string }> {
    const session = await client.session.create({ title: input.title, directory: input.directory })
    const parsedModel = parseModelString(input.model)
    await client.session.promptAsync({
      sessionID: session.id,
      directory: input.directory,
      parts: [{ type: 'text', text: input.prompt }],
      agent: ARCHITECT_AUTO_AGENT,
      ...(parsedModel ? { model: parsedModel } : {}),
      ...(input.variant ? { variant: input.variant } : {}),
    })
    return { sessionId: session.id }
  }

  async function capturePlan(sessionId: string, directory: string): Promise<ArchitectPlanReadiness> {
    const captured = await resolveSessionPlanOfRecord({ client, plansRepo, projectId, directory, logger }, sessionId)
    if (!captured) return { ready: false, reason: NO_STORED_PLAN_REASON }

    const plan = plansRepo.getForSession(projectId, sessionId)
    if (!plan) return { ready: false, reason: NO_STORED_PLAN_REASON }

    const readiness = inspectArchitectPlanReadiness(plan.content)
    if (!readiness.ready) {
      logger.log(`architect-auto-planner: architect ${sessionId} stored an incomplete plan: ${readiness.reason}`)
    }
    return readiness
  }

  async function latestAssistantText(sessionId: string, directory: string): Promise<string | null> {
    const messages = await client.session.messages({
      sessionID: sessionId,
      directory,
      limit: PLAN_CAPTURE_MESSAGE_LIMIT,
    })
    const msgs = (messages ?? []) as Array<{ info: { role?: string }; parts: Array<{ type: string; text?: string }> }>
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      if (msg.info.role !== 'assistant') continue
      for (const part of msg.parts) {
        if (part.type === 'text' && part.text) return part.text
      }
    }
    return null
  }

  return { spawn, capturePlan, latestAssistantText }
}
