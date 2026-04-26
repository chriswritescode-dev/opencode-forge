import type { ApiDeps } from '../types'
import { ok } from '../response'
import { parseJsonBody, ModelPrefsBody } from '../schemas'
import { fetchAvailableModels } from '../../utils/tui-models'
import type { ExecutionPreferences } from '../../utils/tui-execution-preferences'
import {
  readExecutionPreferences,
  resolveExecutionDialogDefaults,
  writeExecutionPreferences,
} from '../../utils/tui-execution-preferences'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'

function mapModelPrefsMode(mode: string | undefined): ExecutionPreferences['mode'] {
  switch (mode) {
    case undefined:
    case 'new-session':
      return 'New session'
    case 'execute-here':
      return 'Execute here'
    case 'loop':
      return 'Loop'
    case 'loop-worktree':
      return 'Loop (worktree)'
    default:
      return 'New session'
  }
}

export async function handleListModels(
  _req: Request,
  deps: ApiDeps
): Promise<Response> {
  // Create a minimal TUI API shape for fetchAvailableModels
  const api = {
    client: deps.ctx.v2,
    state: {
      path: { directory: deps.ctx.directory },
      config: {},
    },
  } as unknown as TuiPluginApi

  const result = await fetchAvailableModels(api)

  if (result.error) {
    return ok({
      providers: result.providers,
      error: result.error,
    })
  }

  return ok({
    providers: result.providers,
    connectedProviderIds: result.connectedProviderIds,
    configuredProviderIds: result.configuredProviderIds,
  })
}

export async function handleGetModelPreferences(
  _req: Request,
  deps: ApiDeps,
  params: Record<string, string>
): Promise<Response> {
  const { projectId } = params
  const prefs = readExecutionPreferences(projectId)
  const defaults = resolveExecutionDialogDefaults(deps.ctx.config, prefs)

  return ok({
    mode: defaults.mode as ExecutionPreferences['mode'],
    executionModel: defaults.executionModel || undefined,
    auditorModel: defaults.auditorModel || undefined,
  })
}

export async function handleWriteModelPreferences(
  req: Request,
  _deps: ApiDeps,
  params: Record<string, string>
): Promise<Response> {
  const { projectId } = params
  const body = await parseJsonBody(req, ModelPrefsBody)

  const prefs: ExecutionPreferences = {
    mode: mapModelPrefsMode(body.mode),
    executionModel: body.executionModel,
    auditorModel: body.auditorModel,
  }
  writeExecutionPreferences(projectId, prefs)

  return ok({ ok: true })
}
