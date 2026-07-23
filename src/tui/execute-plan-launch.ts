/**
 * Pure orchestration extracted from {@link ExecutePlanPanel}'s
 * `runExecuteMode`. Removing it from the component closure makes the panel's
 * label-to-mode routing and audited new-session dispatch independently
 * testable: panel tests call {@link runPlanLaunch} (or
 * {@link resolveApiExecutionMode}) directly with a fake `ForgeProjectClient`
 * instead of rendering the Solid component tree.
 */

import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import { extractPlanExecutionMetadata, matchPlanExecutionLabel } from '../utils/plan-execution'
import { isModeAllowedForTarget } from '../utils/remote-config'
import { executeRemoteLoop } from '../utils/tui-remote-launch'
import type { ApiExecutionMode, ForgeProjectClient } from '../utils/tui-client'
import type { ExecutionContextCache } from '../utils/tui-execution-context-cache'
import type { PluginConfig } from '../types'

type Logger = { log: (message: string) => void; error: (message: string, err?: unknown) => void }

export type { ApiExecutionMode }

/**
 * Maps the user-visible execution-mode label coming from the panel select
 * (e.g. `"New session"`) to the API mode dispatched through
 * `ForgeProjectClient.plan.execute`. Returns `null` when the label does not
 * match any known mode.
 */
export function resolveApiExecutionMode(mode: string): ApiExecutionMode | null {
  const matchedLabel = matchPlanExecutionLabel(mode)
  if (!matchedLabel) return null
  if (matchedLabel === 'Execute here') return 'execute-here'
  if (matchedLabel === 'Loop') return 'loop'
  return 'new-session'
}

export interface PlanLaunchDeps {
  api: TuiPluginApi
  client: ForgeProjectClient
  cache: ExecutionContextCache | null
  pluginConfig: PluginConfig
  logger: Logger
  sessionId: string
  projectDirectory?: string
  planContent: string
  loopName: string
  onExecuted?: () => void | Promise<void>
}

export interface PlanLaunchArgs {
  /** Raw mode label as delivered by the panel select (e.g. `"New session"`). */
  mode: string
  /** Current target value (`'local'` or a configured remote name). */
  target: string
  execModel?: string
  auditModel?: string
  execVariant?: string
  auditVariant?: string
}

async function completeLaunch(
  deps: PlanLaunchDeps,
  outcome: { error: string } | { message: string },
  execModel?: string,
  auditModel?: string,
): Promise<boolean> {
  if ('error' in outcome) {
    deps.api.ui.toast({ message: outcome.error, variant: 'error', duration: 10000 })
    return false
  }
  deps.cache?.recordRecent(execModel || '')
  deps.cache?.recordRecent(auditModel || '')
  deps.api.ui.toast({ message: outcome.message, variant: 'success', duration: 5000 })
  await deps.onExecuted?.()
  return true
}

/**
 * Executes a plan launch from the panel. Mirrors the body previously inlined
 * in {@link ExecutePlanPanel}'s `runExecuteMode`: remote targets only allow
 * Loop mode (and are delegated to `executeRemoteLoop`), local targets resolve
 * the label to an API mode and dispatch through `client.plan.execute`.
 */
export async function runPlanLaunch(deps: PlanLaunchDeps, args: PlanLaunchArgs): Promise<void> {
  const planText = deps.planContent
  const { title } = extractPlanExecutionMetadata(planText)
  const matchedLabel = matchPlanExecutionLabel(args.mode)

  if (args.target !== 'local') {
    if (!isModeAllowedForTarget(args.target, matchedLabel ?? '')) {
      deps.api.ui.toast({ message: 'Remote target supports Loop only', variant: 'error', duration: 5000 })
      return
    }

    deps.api.ui.dialog.clear()
    deps.api.ui.toast({ message: 'Launching remote loop...', variant: 'info', duration: 5000 })
    const result = await executeRemoteLoop({
      remoteName: args.target,
      localDirectory: deps.projectDirectory ?? '',
      localProjectId: deps.client.projectId,
      title,
      loopName: deps.loopName,
      plan: planText,
      executionModel: args.execModel,
      auditorModel: args.auditModel,
      executionVariant: args.execVariant,
      auditorVariant: args.auditVariant,
    }, {
      config: deps.pluginConfig,
      onWarning: (m) => deps.api.ui.toast({ message: m, variant: 'info', duration: 5000 }),
      debug: (m) => deps.logger.log(m),
    })
    if ('error' in result) {
      deps.logger.error(`remote-launch: failed on "${args.target}": ${result.error}`)
    }

    await completeLaunch(
      deps,
      'error' in result
        ? result
        : { message: `Remote loop started: ${result.loopName} on ${result.remoteName}` },
      args.execModel,
      args.auditModel,
    )
    return
  }

  const apiMode = resolveApiExecutionMode(args.mode)
  if (!apiMode) return

  deps.api.ui.dialog.clear()
  deps.api.ui.toast({ message: 'Executing plan...', variant: 'info', duration: 3000 })
  let result!: Awaited<ReturnType<typeof deps.client.plan.execute>>
  try {
    result = await deps.client.plan.execute(deps.sessionId, {
      mode: apiMode,
      title,
      loopName: deps.loopName,
      plan: planText,
      executionModel: args.execModel,
      auditorModel: args.auditModel,
      executionVariant: args.execVariant,
      auditorVariant: args.auditVariant,
      targetSessionId: deps.sessionId,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    deps.logger.error(`plan.execute threw for mode=${apiMode}: ${message}`)
    deps.api.ui.toast({ message: `Failed to execute plan: ${message}`, variant: 'error', duration: 5000 })
    return
  }

  if (!result) {
    deps.api.ui.toast({ message: 'Failed to execute plan', variant: 'error', duration: 3000 })
    return
  }

  if ('error' in result) {
    await completeLaunch(deps, result)
    return
  }

  const fallbackMessage = apiMode === 'new-session'
    ? 'Plan execution started (one-shot fallback: no tracked goal loop)'
    : 'Plan execution started'
  await completeLaunch(
    deps,
    { message: result.loopName ? `Loop started: ${result.loopName}` : fallbackMessage },
    args.execModel,
    args.auditModel,
  )
  deps.client.workspaces.list().catch(() => {})
  if (result.sessionId && (apiMode === 'new-session' || apiMode === 'loop')) {
    await deps.client.selectSession(result.sessionId, result.workspaceId)
  }
}
