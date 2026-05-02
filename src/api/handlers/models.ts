import type { ApiDeps } from '../types'
import { ModelPrefsBody, type ModelPrefs } from '../schemas'
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
  deps: ApiDeps,
  _params: Record<string, string>,
  _body: unknown
): Promise<unknown> {
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
    return {
      providers: result.providers,
      error: result.error,
      favoriteModels: result.favoriteModels,
    }
  }

  return {
    providers: result.providers,
    connectedProviderIds: result.connectedProviderIds,
    configuredProviderIds: result.configuredProviderIds,
    favoriteModels: result.favoriteModels,
  }
}

export async function handleGetModelPreferences(
  deps: ApiDeps,
  params: Record<string, string>,
  _body: unknown
): Promise<unknown> {
  const { projectId } = params
  const prefs = readExecutionPreferences(projectId)
  const defaults = resolveExecutionDialogDefaults(deps.ctx.config, prefs)

  return {
    mode: defaults.mode as ExecutionPreferences['mode'],
    executionModel: defaults.executionModel || undefined,
    auditorModel: defaults.auditorModel || undefined,
  }
}

import { ForgeRpcError } from '../bus-protocol'

export async function handleWriteModelPreferences(
  _deps: ApiDeps,
  params: Record<string, string>,
  body: unknown
): Promise<unknown> {
  const { projectId } = params
  
  let parsed: ModelPrefs
  try {
    parsed = ModelPrefsBody.parse(body)
  } catch {
    throw new ForgeRpcError('bad_request', 'invalid preference body')
  }

  const prefs: ExecutionPreferences = {
    mode: mapModelPrefsMode(parsed.mode),
    executionModel: parsed.executionModel,
    auditorModel: parsed.auditorModel,
  }
  writeExecutionPreferences(projectId, prefs)

  return { ok: true }
}
