import { describe, test, expect } from 'vitest'
import {
  deriveExecutionPreferencesFromWorkspaces,
  resolveExecutionDialogDefaults,
  type ExecutionPreferences,
} from '../src/utils/tui-execution-preferences'
import type { PluginConfig } from '../src/types'
import type { WorkspaceForRecents } from '../src/utils/tui-models'

const PROJECT_A = 'project-a'
const PROJECT_B = 'project-b'

function forgeWs(input: {
  timeUsed?: number | string
  projectID?: string
  executionModel?: string
  auditorModel?: string
  executionVariant?: string
  auditorVariant?: string
  extraOverride?: unknown
}): WorkspaceForRecents {
  const forgeLoop: Record<string, unknown> = {}
  if (input.executionModel !== undefined) forgeLoop.executionModel = input.executionModel
  if (input.auditorModel !== undefined) forgeLoop.auditorModel = input.auditorModel
  if (input.executionVariant !== undefined) forgeLoop.executionVariant = input.executionVariant
  if (input.auditorVariant !== undefined) forgeLoop.auditorVariant = input.auditorVariant
  return {
    type: 'forge',
    ...(input.projectID !== undefined ? { projectID: input.projectID } : {}),
    ...(input.timeUsed !== undefined ? { timeUsed: input.timeUsed } : {}),
    extra: input.extraOverride !== undefined ? input.extraOverride : { forgeLoop },
  }
}

describe('deriveExecutionPreferencesFromWorkspaces', () => {
  test('returns null for empty workspace list', () => {
    expect(deriveExecutionPreferencesFromWorkspaces(PROJECT_A, [])).toBeNull()
  })

  test('returns null when no workspace is type=forge', () => {
    const workspaces: WorkspaceForRecents[] = [
      { type: 'local', projectID: PROJECT_A, timeUsed: 1, extra: { forgeLoop: { executionModel: 'a/b' } } },
      { type: 'worktree', projectID: PROJECT_A, timeUsed: 2, extra: { forgeLoop: { executionModel: 'c/d' } } },
    ]
    expect(deriveExecutionPreferencesFromWorkspaces(PROJECT_A, workspaces)).toBeNull()
  })

  test('returns null when forge workspaces have no `extra.forgeLoop`', () => {
    const workspaces: WorkspaceForRecents[] = [
      forgeWs({ projectID: PROJECT_A, timeUsed: 100, extraOverride: { somethingElse: 1 } }),
      forgeWs({ projectID: PROJECT_A, timeUsed: 50, extraOverride: { forgeLoop: null } }),
      forgeWs({ projectID: PROJECT_A, timeUsed: 25, extraOverride: null }),
    ]
    expect(deriveExecutionPreferencesFromWorkspaces(PROJECT_A, workspaces)).toBeNull()
  })

  test('returns the most recent workspace prefs (Loop mode, fields extracted)', () => {
    const workspaces = [
      forgeWs({
        projectID: PROJECT_A,
        timeUsed: 200,
        executionModel: 'anthropic/claude-sonnet-4',
        auditorModel: 'openai/gpt-5',
        executionVariant: 'thinking-max',
        auditorVariant: 'reasoning-high',
      }),
    ]
    expect(deriveExecutionPreferencesFromWorkspaces(PROJECT_A, workspaces)).toEqual({
      mode: 'Loop',
      executionModel: 'anthropic/claude-sonnet-4',
      auditorModel: 'openai/gpt-5',
      executionVariant: 'thinking-max',
      auditorVariant: 'reasoning-high',
    })
  })

  test('picks the workspace with the highest timeUsed (recency)', () => {
    const workspaces = [
      forgeWs({ projectID: PROJECT_A, timeUsed: 100, executionModel: 'older/model' }),
      forgeWs({ projectID: PROJECT_A, timeUsed: 300, executionModel: 'newest/model' }),
      forgeWs({ projectID: PROJECT_A, timeUsed: 200, executionModel: 'middle/model' }),
    ]
    expect(deriveExecutionPreferencesFromWorkspaces(PROJECT_A, workspaces)?.executionModel).toBe('newest/model')
  })

  test('ignores workspaces from other projects', () => {
    const workspaces = [
      forgeWs({ projectID: PROJECT_B, timeUsed: 1000, executionModel: 'foreign/model' }),
      forgeWs({ projectID: PROJECT_A, timeUsed: 100, executionModel: 'mine/model' }),
    ]
    expect(deriveExecutionPreferencesFromWorkspaces(PROJECT_A, workspaces)?.executionModel).toBe('mine/model')
  })

  test('includes workspaces with no projectID (forward-compat)', () => {
    const workspaces = [
      forgeWs({ timeUsed: 100, executionModel: 'legacy/model' }),
    ]
    expect(deriveExecutionPreferencesFromWorkspaces(PROJECT_A, workspaces)?.executionModel).toBe('legacy/model')
  })

  test('omits fields that are missing or non-string in extra.forgeLoop', () => {
    const workspaces: WorkspaceForRecents[] = [
      forgeWs({
        projectID: PROJECT_A,
        timeUsed: 100,
        extraOverride: { forgeLoop: { executionModel: 'anthropic/claude', auditorModel: 42, executionVariant: '' } },
      }),
    ]
    const prefs = deriveExecutionPreferencesFromWorkspaces(PROJECT_A, workspaces)
    expect(prefs).toEqual({
      mode: 'Loop',
      executionModel: 'anthropic/claude',
      auditorModel: undefined,
      executionVariant: undefined,
      auditorVariant: undefined,
    })
  })

  test('treats non-finite `timeUsed` as 0 (loses recency comparison)', () => {
    const workspaces = [
      forgeWs({ projectID: PROJECT_A, timeUsed: 'NaN', executionModel: 'nan/model' }),
      forgeWs({ projectID: PROJECT_A, timeUsed: 'Infinity', executionModel: 'inf/model' }),
      forgeWs({ projectID: PROJECT_A, timeUsed: 1, executionModel: 'real/model' }),
    ]
    expect(deriveExecutionPreferencesFromWorkspaces(PROJECT_A, workspaces)?.executionModel).toBe('real/model')
  })

  test('skips non-object / null extra entries when scanning', () => {
    const workspaces: WorkspaceForRecents[] = [
      { type: 'forge', projectID: PROJECT_A, timeUsed: 400, extra: null },
      { type: 'forge', projectID: PROJECT_A, timeUsed: 300, extra: 'oops' as unknown },
      forgeWs({ projectID: PROJECT_A, timeUsed: 100, executionModel: 'real/model' }),
    ]
    expect(deriveExecutionPreferencesFromWorkspaces(PROJECT_A, workspaces)?.executionModel).toBe('real/model')
  })
})

describe('resolveExecutionDialogDefaults', () => {
  test('uses stored prefs first', () => {
    const config: PluginConfig = {
      executionModel: 'anthropic/claude-3-haiku',
      loop: { model: 'anthropic/claude-3-sonnet' },
      auditorModel: 'anthropic/claude-3-opus',
    }
    const storedPrefs: ExecutionPreferences = {
      mode: 'New session',
      executionModel: 'anthropic/claude-3-5-sonnet',
      auditorModel: 'anthropic/claude-3-opus',
    }

    const result = resolveExecutionDialogDefaults(config, storedPrefs)
    expect(result.mode).toBe('New session')
    expect(result.executionModel).toBe('anthropic/claude-3-5-sonnet')
    expect(result.auditorModel).toBe('anthropic/claude-3-opus')
  })

  test('falls back to config when no stored prefs', () => {
    const config: PluginConfig = {
      executionModel: 'anthropic/claude-3-haiku',
      loop: { model: 'anthropic/claude-3-sonnet' },
      auditorModel: 'anthropic/claude-3-opus',
    }

    const result = resolveExecutionDialogDefaults(config, null)
    expect(result.mode).toBe('Loop')
    expect(result.executionModel).toBe('anthropic/claude-3-haiku')
    expect(result.auditorModel).toBe('anthropic/claude-3-opus')
  })

  test('falls back through config hierarchy', () => {
    const config: Partial<PluginConfig> = {
      executionModel: 'anthropic/claude-3-haiku',
    }

    const result = resolveExecutionDialogDefaults(config as PluginConfig, null)
    expect(result.executionModel).toBe('anthropic/claude-3-haiku')
    expect(result.auditorModel).toBe('anthropic/claude-3-haiku')
  })

  test('handles empty config', () => {
    const config: PluginConfig = {} as PluginConfig

    const result = resolveExecutionDialogDefaults(config, null)
    expect(result.mode).toBe('Loop')
    expect(result.executionModel).toBe('')
    expect(result.auditorModel).toBe('')
  })

  test('normalizes legacy "Loop (worktree)" mode to "Loop"', () => {
    const config: PluginConfig = {
      executionModel: 'anthropic/claude-3-haiku',
      auditorModel: 'anthropic/claude-3-opus',
    }
    const storedPrefs = {
      mode: 'Loop (worktree)',
      executionModel: 'anthropic/claude-3-5-sonnet',
      auditorModel: 'anthropic/claude-3-opus',
    } as unknown as ExecutionPreferences

    const result = resolveExecutionDialogDefaults(config, storedPrefs)
    expect(result.mode).toBe('Loop')
    expect(result.executionModel).toBe('anthropic/claude-3-5-sonnet')
    expect(result.auditorModel).toBe('anthropic/claude-3-opus')
  })

  test('normalizes legacy "loop-worktree" mode to "Loop"', () => {
    const config: PluginConfig = {
      executionModel: 'anthropic/claude-3-haiku',
      auditorModel: 'anthropic/claude-3-opus',
    }
    const storedPrefs = {
      mode: 'loop-worktree',
      executionModel: 'anthropic/claude-3-5-sonnet',
      auditorModel: 'anthropic/claude-3-opus',
    } as unknown as ExecutionPreferences

    const result = resolveExecutionDialogDefaults(config, storedPrefs)
    expect(result.mode).toBe('Loop')
  })

  test('returns stored variants when present', () => {
    const config: PluginConfig = {
      executionModel: 'anthropic/claude-3-haiku',
      auditorModel: 'anthropic/claude-3-opus',
    }
    const storedPrefs: ExecutionPreferences = {
      mode: 'Loop',
      executionModel: 'anthropic/claude-3-5-sonnet',
      auditorModel: 'anthropic/claude-3-opus',
      executionVariant: 'thinking-max',
      auditorVariant: 'reasoning-high',
    }

    const result = resolveExecutionDialogDefaults(config, storedPrefs)
    expect(result.executionVariant).toBe('thinking-max')
    expect(result.auditorVariant).toBe('reasoning-high')
  })

  test('defaults missing variants to empty string', () => {
    const config: PluginConfig = {
      executionModel: 'anthropic/claude-3-haiku',
      auditorModel: 'anthropic/claude-3-opus',
    }

    const result = resolveExecutionDialogDefaults(config, null)
    expect(result.executionVariant).toBe('')
    expect(result.auditorVariant).toBe('')
  })

  test('treats explicit `undefined` variants as empty string', () => {
    const config: PluginConfig = {
      executionModel: 'anthropic/claude-3-haiku',
      auditorModel: 'anthropic/claude-3-opus',
    }
    const storedPrefs: ExecutionPreferences = {
      mode: 'Loop',
      executionModel: 'anthropic/claude-3-5-sonnet',
      auditorModel: 'anthropic/claude-3-opus',
      executionVariant: undefined,
      auditorVariant: undefined,
    }
    const result = resolveExecutionDialogDefaults(config, storedPrefs)
    expect(result.executionVariant).toBe('')
    expect(result.auditorVariant).toBe('')
  })
})

describe('deriveExecutionPreferencesFromWorkspaces + resolveExecutionDialogDefaults composition', () => {
  test('derived prefs feed cleanly into resolveExecutionDialogDefaults', () => {
    const workspaces = [
      forgeWs({
        projectID: PROJECT_A,
        timeUsed: 200,
        executionModel: 'derived/exec',
        auditorModel: 'derived/audit',
        executionVariant: 'thinking-max',
      }),
    ]
    const derived = deriveExecutionPreferencesFromWorkspaces(PROJECT_A, workspaces)
    const config: PluginConfig = {
      executionModel: 'config/fallback',
      auditorModel: 'config/auditor-fallback',
    }
    const result = resolveExecutionDialogDefaults(config, derived)
    expect(result.mode).toBe('Loop')
    expect(result.executionModel).toBe('derived/exec')
    expect(result.auditorModel).toBe('derived/audit')
    expect(result.executionVariant).toBe('thinking-max')
    expect(result.auditorVariant).toBe('')
  })

  test('null derived prefs cleanly falls back to config in resolveExecutionDialogDefaults', () => {
    const derived = deriveExecutionPreferencesFromWorkspaces(PROJECT_A, [])
    expect(derived).toBeNull()
    const config: PluginConfig = {
      executionModel: 'config/exec',
      auditorModel: 'config/audit',
    }
    const result = resolveExecutionDialogDefaults(config, derived)
    expect(result.executionModel).toBe('config/exec')
    expect(result.auditorModel).toBe('config/audit')
  })
})
