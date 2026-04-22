/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from '@opencode-ai/plugin/tui'
import { createEffect, createMemo, createSignal, onCleanup, Show, For } from 'solid-js'
import { SyntaxStyle, type TextareaRenderable } from '@opentui/core'
import { readFileSync, existsSync, writeFileSync } from 'fs'
import { homedir, platform } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { VERSION } from './version'
import { resolveDataDir } from './storage'
import { fetchSessionStats, type SessionStats } from './utils/session-stats'
import { slugify } from './utils/logger'
import { extractPlanTitle, PLAN_EXECUTION_LABELS, matchExecutionLabel, type PlanExecutionLabel } from './utils/plan-execution'
import { launchFreshLoop } from './utils/loop-launch'
import { readPlan, writePlan, deletePlan } from './utils/tui-plan-store'
import { readGraphStatus, formatGraphStatus } from './utils/tui-graph-status'
import { readLoopStates, readLoopByName, shouldPollSidebar, type LoopInfo } from './utils/tui-refresh-helpers'
import { readExecutionPreferences, writeExecutionPreferences, resolveExecutionDialogDefaults } from './utils/tui-execution-preferences'
import { fetchAvailableModels, flattenProviders, buildDialogSelectOptions, getModelDisplayLabel, getRecentModels, recordRecentModel, sortModelsByPriority, type ModelInfo } from './utils/tui-models'
import { getGitProjectId } from './utils/project-id'
import { formatDuration, formatTokens, truncate, truncateMiddle } from './utils/format'

import { buildLoopPermissionRuleset } from './constants/loop'
import { createLoopSessionWithWorkspace } from './utils/loop-session'

type TuiKeybinds = {
  viewPlan: string
  executePlan: string
  showLoops: string
}

const DEFAULT_KEYBINDS: TuiKeybinds = {
  viewPlan: '<leader>v',
  executePlan: '<leader>e',
  showLoops: '<leader>w',
}

type TuiOptions = {
  sidebar: boolean
  showLoops: boolean
  showVersion: boolean
  keybinds: TuiKeybinds
}

type TuiConfig = {
  sidebar?: boolean
  showLoops?: boolean
  showVersion?: boolean
  keybinds?: Partial<TuiKeybinds>
}



function loadTuiConfig(): TuiConfig | undefined {
  try {
    const defaultBase = join(homedir(), platform() === 'win32' ? 'AppData' : '.config')
    const configDir = process.env['XDG_CONFIG_HOME'] || defaultBase
    const configRoot = join(configDir, 'opencode')
    const configPath = existsSync(join(configRoot, 'forge-config.jsonc'))
      ? join(configRoot, 'forge-config.jsonc')
      : existsSync(join(configRoot, 'memory-config.jsonc'))
        ? join(configRoot, 'memory-config.jsonc')
        : join(configRoot, 'graph-config.jsonc')
    const raw = readFileSync(configPath, 'utf-8')
    const stripped = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    const parsed = JSON.parse(stripped)
    return parsed?.tui
  } catch {
    return undefined
  }
}





function cancelLoop(projectId: string, loopName: string): string | null {
  const dbPath = join(resolveDataDir(), 'graph.db')

  if (!existsSync(dbPath)) return null

  let db: Database | null = null
  try {
    db = new Database(dbPath)
    db.run('PRAGMA busy_timeout=5000')
    const row = db.prepare(`
      SELECT status, current_session_id
      FROM loops
      WHERE project_id = ? AND loop_name = ?
    `).get(projectId, loopName) as { status: string; current_session_id: string } | null
    
    if (!row) return null
    if (row.status !== 'running') return null

    const now = Date.now()
    db.prepare(`
      UPDATE loops SET
        status = ?,
        completed_at = ?,
        termination_reason = ?,
        completion_summary = ?
      WHERE project_id = ? AND loop_name = ?
    `).run('cancelled', now, 'cancelled', null, projectId, loopName)
    
    return row.current_session_id
  } catch {
    return null
  } finally {
    try { db?.close() } catch {}
  }
}

async function restartLoop(projectId: string, loopName: string, api: TuiPluginApi): Promise<string | null> {
  const dbPath = join(resolveDataDir(), 'graph.db')

  if (!existsSync(dbPath)) return null

  let db: Database | null = null
  try {
    db = new Database(dbPath)
    db.run('PRAGMA busy_timeout=5000')
    const now = Date.now()
    const row = db.prepare(`
      SELECT status, current_session_id, worktree_dir, worktree, project_dir, execution_model,
             auditor_model, prompt, iteration, phase, audit, sandbox,
             worktree_branch, workspace_id
      FROM loops
      LEFT JOIN loop_large_fields USING (project_id, loop_name)
      WHERE project_id = ? AND loop_name = ?
    `).get(projectId, loopName) as {
      status: string
      current_session_id: string
      worktree_dir: string
      worktree: number
      project_dir: string
      execution_model: string | null
      auditor_model: string | null
      prompt: string | null
      iteration: number
      phase: string
      audit: number
      sandbox: number
      worktree_branch: string | null
      workspace_id: string | null
    } | null
    
    if (!row) return null

    const oldSessionId = row.current_session_id
    if (row.status === 'running') {
      try { await api.client.session.abort({ sessionID: oldSessionId }) } catch {}
    }

    const directory = row.worktree_dir
    if (!directory) return null

    const { loadPluginConfig } = await import('./setup')
    const config = loadPluginConfig()
    const permissionRuleset = buildLoopPermissionRuleset({
      isWorktree: !!row.worktree,
      isSandbox: !!row.sandbox,
    })

    // Resolve the workspace ID for worktree loops.
    // - If the loop already has workspace_id, use it.
    // - If it's a legacy worktree loop (no workspace_id), create a workspace record now
    //   and persist it back to the row for future restarts.
    let workspaceId: string | null = row.workspace_id ?? null
    if (row.worktree === 1 && !workspaceId) {
      const { createLoopWorkspace } = await import('./workspace/forge-worktree')
      const ws = await createLoopWorkspace(api.client, {
        loopName,
        directory,
        branch: row.worktree_branch ?? null,
      })
      if (!ws) {
        console.error(`[forge] restartLoop: failed to create workspace for legacy worktree loop ${loopName}`)
        return null
      }
      workspaceId = ws.workspaceId
      db.prepare('UPDATE loops SET workspace_id = ? WHERE project_id = ? AND loop_name = ?').run(
        workspaceId, projectId, loopName
      )
    }

    const createResult = await createLoopSessionWithWorkspace({
      v2: api.client,
      title: loopName,
      directory,
      permission: permissionRuleset,
      workspaceId: workspaceId ?? undefined,
      logPrefix: 'tui-restart',
      logger: console,
    })
    if (!createResult) return null

    const newSessionId = createResult.sessionId

    // Update loops table FIRST before sending prompt so resolveLoopName works immediately
    db.prepare(`
      UPDATE loops SET
        status = ?,
        current_session_id = ?,
        phase = ?,
        iteration = ?,
        error_count = ?,
        audit_count = ?,
        started_at = ?,
        completed_at = ?,
        termination_reason = ?,
        completion_summary = ?
      WHERE project_id = ? AND loop_name = ?
    `).run(
      'running',
      newSessionId,
      row.phase,
      row.iteration,
      0,
      0,
      now,
      null,
      null,
      null,
      projectId,
      loopName
    )

    const promptText = row.prompt ?? ''

    const { parseModelString, retryWithModelFallback } = await import('./utils/model-fallback')
    const loopModel = parseModelString(row.execution_model ?? undefined)
      ?? parseModelString(config.loop?.model)
      ?? parseModelString(config.executionModel)

    const { waitForSandboxReady } = await import('./utils/sandbox-ready')
    const waitResult = await waitForSandboxReady({
      projectId,
      loopName,
      dbPath,
      pollMs: 200,
      timeoutMs: 15_000,
    })
    if (!waitResult.ready) {
      console.error(`[forge] restartLoop: sandbox not ready (${waitResult.reason}); aborting restart`)

      try {
        const { createDockerService } = await import('./sandbox/docker')
        const docker = createDockerService(console)
        const containerName = docker.containerName(loopName)
        if (await docker.isRunning(containerName)) {
          await docker.removeContainer(containerName)
          console.log(`[forge] restartLoop: removed sandbox container ${containerName} after aborted restart`)
        }
      } catch (err) {
        console.error('[forge] restartLoop: failed to remove sandbox container after abort', err)
      }

      try {
        db.prepare(`
          UPDATE loops SET
            status = ?,
            completed_at = ?,
            termination_reason = ?,
            completion_summary = ?
          WHERE project_id = ? AND loop_name = ?
        `).run('errored', now, 'sandbox_start_failed: ' + waitResult.reason, null, projectId, loopName)
      } catch (err) {
        console.error('[forge] restartLoop: failed to mark loop inactive after sandbox timeout', err)
      }
      return null
    }
    console.log(`[forge] restartLoop: sandbox ready container=${waitResult.containerName}`)

    const promptParts: Array<{ type: 'text'; text: string }> = [{ type: 'text' as const, text: promptText }]
    
    const { result: promptResult } = await retryWithModelFallback(
      () => loopModel
        ? api.client.session.promptAsync({ sessionID: newSessionId, directory, agent: 'code', model: loopModel, parts: promptParts })
        : api.client.session.promptAsync({ sessionID: newSessionId, directory, agent: 'code', parts: promptParts }),
      () => api.client.session.promptAsync({ sessionID: newSessionId, directory, agent: 'code', parts: promptParts }),
      loopModel,
      console,
    )
    
    if (promptResult.error) {
      throw new Error('Failed to prompt restarted loop')
    }

    return newSessionId
  } catch {
    return null
  } finally {
    try { db?.close() } catch {}
  }
}

function PlanViewerDialog(props: {
  api: TuiPluginApi
  planContent: string
  projectId: string
  sessionId: string
  onRefresh?: () => void
  startInExecuteMode?: boolean
  initialExecutionModel?: string
  initialAuditorModel?: string
}) {
  const theme = () => props.api.theme.current
  const [editing, setEditing] = createSignal(false)
  const [executing, setExecuting] = createSignal(props.startInExecuteMode ?? false)
  const [content, setContent] = createSignal(props.planContent)
  const [defaultsLoaded, setDefaultsLoaded] = createSignal(false)
  const [allModels, setAllModels] = createSignal<ModelInfo[]>([])
  const [modelsLoaded, setModelsLoaded] = createSignal(false)
  const [modelsError, setModelsError] = createSignal<string | undefined>(undefined)
  const [executionModel, setExecutionModel] = createSignal<string>(props.initialExecutionModel ?? '')
  const [auditorModel, setAuditorModel] = createSignal<string>(props.initialAuditorModel ?? '')
  const [recentModelIds, setRecentModelIds] = createSignal<string[]>([])
  let textareaRef: TextareaRenderable | undefined

  const hasInitialOverrides = props.initialExecutionModel !== undefined || props.initialAuditorModel !== undefined

  // Load last-used preferences for dialog defaults
  const directory = props.api.state.path.directory
  const pid = getGitProjectId(directory)
  const loadDefaults = async () => {
    if (pid) {
      const storedPrefs = readExecutionPreferences(pid)
      const { loadPluginConfig } = await import('./setup')
      const config = loadPluginConfig()
      const defaults = resolveExecutionDialogDefaults(config, storedPrefs)
      if (!hasInitialOverrides) {
        setExecutionModel(defaults.executionModel)
        setAuditorModel(defaults.auditorModel)
      }
      setDefaultsLoaded(true)
    } else {
      setDefaultsLoaded(true)
    }
  }

  // Load available models from API (also loads recents for categorization)
  const loadModels = async () => {
    const result = await fetchAvailableModels(props.api)
    if (result.error) {
      setModelsError(result.error)
      setModelsLoaded(true)
      return
    }
    const allModelList = flattenProviders(result.providers)
    const recents = pid ? getRecentModels(pid) : []
    setRecentModelIds(recents)
    const sorted = sortModelsByPriority(allModelList, {
      recents,
      connectedProviderIds: result.connectedProviderIds,
      configuredProviderIds: result.configuredProviderIds,
    })
    setAllModels(sorted)
    setModelsLoaded(true)
  }

  loadDefaults()
  loadModels()

  const handleSave = () => {
    const text = textareaRef?.plainText ?? content()
    const saved = writePlan(props.projectId, props.sessionId, text)
    props.api.ui.toast({
      message: saved ? 'Plan saved' : 'Failed to save plan',
      variant: saved ? 'success' : 'error',
      duration: 3000,
    })
    if (saved) {
      setContent(text)
      setEditing(false)
    }
  }

  const handleExport = () => {
    const planText = content()
    const title = extractPlanTitle(planText)
    const slugifiedTitle = slugify(title)
    const directory = props.api.state.path.directory
    const filename = `${slugifiedTitle}.md`
    const filepath = join(directory, filename)

    try {
      writeFileSync(filepath, planText, 'utf-8')
      props.api.ui.toast({
        message: `Exported plan to ${filename}`,
        variant: 'success',
        duration: 3000,
      })
    } catch (error) {
      props.api.ui.toast({
        message: `Failed to export plan: ${(error as Error).message}`,
        variant: 'error',
        duration: 3000,
      })
    }
  }

  const openModelDialog = (target: 'execution' | 'auditor') => {
    if (!modelsLoaded()) return

    const models = allModels()
    if (modelsError() || models.length === 0) {
      props.api.ui.toast({ message: modelsError() || 'No models available', variant: 'error', duration: 3000 })
      return
    }

    const options = buildDialogSelectOptions(models, recentModelIds())
    const title = target === 'execution' ? 'Execution Model' : 'Auditor Model'
    const currentValue = target === 'execution' ? executionModel() : auditorModel()

    props.api.ui.dialog.setSize('large')
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogSelect
        title={title}
        options={options}
        current={currentValue || ''}
        onSelect={(opt) => {
          const selectedModel = typeof opt.value === 'string' ? opt.value : ''
          props.api.ui.dialog.setSize('xlarge')
          props.api.ui.dialog.replace(() => (
            <PlanViewerDialog
              api={props.api}
              planContent={content()}
              projectId={props.projectId}
              sessionId={props.sessionId}
              onRefresh={props.onRefresh}
              startInExecuteMode={true}
              initialExecutionModel={target === 'execution' ? selectedModel : executionModel()}
              initialAuditorModel={target === 'auditor' ? selectedModel : auditorModel()}
            />
          ))
        }}
      />
    ))
  }

  function getModeDescription(label: string): string {
    switch (label) {
      case 'New session':
        return 'Create a new session and send the plan to the code agent'
      case 'Execute here':
        return 'Execute the plan in the current session using the code agent'
      case 'Loop (worktree)':
        return 'Execute using iterative development loop in an isolated git worktree'
      case 'Loop':
        return 'Execute using iterative development loop in the current directory'
      default:
        return ''
    }
  }

  const handleExecuteMode = async (mode: string, executionModel?: string, auditorModel?: string) => {
    const planText = content()
    const title = extractPlanTitle(planText)
    const directory = props.api.state.path.directory
    const pid = getGitProjectId(directory)
    
    if (!pid) {
      props.api.ui.toast({
        message: 'Failed to resolve project ID',
        variant: 'error',
        duration: 3000,
      })
      return
    }

    // Use canonical label matching instead of fragile string comparison
    const matchedLabel = matchExecutionLabel(mode)
    
    switch (matchedLabel) {
      case 'New session': {
        props.api.ui.dialog.clear()
        props.api.ui.toast({
          message: 'Creating new session for plan execution...',
          variant: 'info',
          duration: 3000,
        })

        try {
          const createResult = await props.api.client.session.create({ 
            title, 
            directory 
          })
          
          if (createResult.error || !createResult.data) {
            props.api.ui.toast({
              message: 'Failed to create new session',
              variant: 'error',
              duration: 3000,
            })
            return
          }
          
          const newSessionId = createResult.data.id
          
          // Delete plan from old session
          if (pid) {
            deletePlan(pid, props.sessionId)
          }
          
          // Use execution model with retryWithModelFallback pattern
          const { parseModelString, retryWithModelFallback } = await import('./utils/model-fallback')
          const { loadPluginConfig } = await import('./setup')
          const config = loadPluginConfig()
          const model = parseModelString(executionModel) ?? parseModelString(config.loop?.model) ?? parseModelString(config.executionModel)
          
          const promptParts = [{ type: 'text' as const, text: planText }]
          const { result: promptResult } = await retryWithModelFallback(
            () => model
              ? props.api.client.session.promptAsync({ sessionID: newSessionId, directory, agent: 'code', model, parts: promptParts })
              : props.api.client.session.promptAsync({ sessionID: newSessionId, directory, agent: 'code', parts: promptParts }),
            () => props.api.client.session.promptAsync({ sessionID: newSessionId, directory, agent: 'code', parts: promptParts }),
            model,
            console,
          )
          
          if (promptResult.error) {
            throw new Error('Failed to prompt session')
          }
          
          props.api.ui.toast({
            message: `New session created: ${title}`,
            variant: 'success',
            duration: 3000,
          })
          
          // Save execution preferences and record recent models
          writeExecutionPreferences(pid, {
            mode: matchedLabel as PlanExecutionLabel,
            executionModel,
            auditorModel,
          })
          if (executionModel) recordRecentModel(pid, executionModel)
          if (auditorModel) recordRecentModel(pid, auditorModel)

          // Refresh sidebar immediately after mutation is issued
          props.onRefresh?.()
          
          try {
            props.api.route.navigate('session', { sessionID: newSessionId })
          } catch {}
        } catch {
          props.api.ui.toast({
            message: 'Failed to create new session',
            variant: 'error',
            duration: 3000,
          })
        }
        break
      }
      
      case 'Execute here': {
        props.api.ui.dialog.clear()
        props.api.ui.toast({
          message: 'Switching to code agent for plan execution...',
          variant: 'info',
          duration: 3000,
        })

        const inPlacePrompt = `The architect agent has created an implementation plan. You are now the code agent taking over this session. Your job is to execute the plan — edit files, run commands, create tests, and implement every phase. Do NOT just describe or summarize the changes. Actually make them.\n\nImplementation Plan:\n${planText}`
        
        try {
          const { parseModelString, retryWithModelFallback } = await import('./utils/model-fallback')
          const { loadPluginConfig } = await import('./setup')
          const config = loadPluginConfig()
          const model = parseModelString(executionModel) ?? parseModelString(config.loop?.model) ?? parseModelString(config.executionModel)
          
          const promptParts = [{ type: 'text' as const, text: inPlacePrompt }]
          const { result: promptResult } = await retryWithModelFallback(
            () => model
              ? props.api.client.session.promptAsync({ sessionID: props.sessionId, directory, agent: 'code', model, parts: promptParts })
              : props.api.client.session.promptAsync({ sessionID: props.sessionId, directory, agent: 'code', parts: promptParts }),
            () => props.api.client.session.promptAsync({ sessionID: props.sessionId, directory, agent: 'code', parts: promptParts }),
            model,
            console,
          )
          
          if (promptResult.error) {
            throw new Error('Failed to prompt session')
          }
          
          props.api.ui.toast({
            message: 'Executing plan in current session',
            variant: 'success',
            duration: 3000,
          })
          
          // Save execution preferences and record recent models
          writeExecutionPreferences(pid, {
            mode: matchedLabel as PlanExecutionLabel,
            executionModel,
            auditorModel,
          })
          if (executionModel) recordRecentModel(pid, executionModel)
          if (auditorModel) recordRecentModel(pid, auditorModel)

          // Refresh sidebar immediately after mutation is issued
          props.onRefresh?.()
        } catch {
          props.api.ui.toast({
            message: 'Failed to execute plan in current session',
            variant: 'error',
            duration: 3000,
          })
        }
        break
      }
      
      case 'Loop (worktree)':
      case 'Loop': {
        const isWorktree = matchedLabel === 'Loop (worktree)'
        
        props.api.ui.dialog.clear()
        props.api.ui.toast({
          message: isWorktree ? 'Starting loop in worktree...' : 'Starting loop in-place...',
          variant: 'info',
          duration: 3000,
        })

        // Use fresh loop launch helper instead of restartLoop
        // This creates a new loop session rather than requiring preexisting state
        try {
          const launchResult = await launchFreshLoop({
            planText,
            title,
            directory,
            projectId: pid,
            isWorktree,
            api: props.api,
            executionModel,
            auditorModel,
            hostSessionId: props.sessionId,
          })
          
          if (launchResult) {
            // Delete plan from old session after successful launch
            if (pid) {
              deletePlan(pid, props.sessionId)
            }
            
            // Save execution preferences after successful launch
            writeExecutionPreferences(pid, {
              mode: matchedLabel as PlanExecutionLabel,
              executionModel,
              auditorModel,
            })
            if (executionModel) recordRecentModel(pid, executionModel)
            if (auditorModel) recordRecentModel(pid, auditorModel)

            // Use the actual loop name returned by the launcher
            props.api.ui.toast({
              message: isWorktree ? `Loop started in worktree: ${launchResult.loopName}` : `Loop started: ${launchResult.loopName}`,
              variant: 'success',
              duration: 3000,
            })

            // For workspace-backed worktree loops, navigate to the session immediately.
            if (isWorktree && launchResult.workspaceId && launchResult.sessionId) {
              try {
                props.api.route.navigate('session', { sessionID: launchResult.sessionId })
              } catch {}
            }

            // Refresh sidebar immediately after mutation is issued
            props.onRefresh?.()
          }
        } catch {
          props.api.ui.toast({
            message: 'Failed to start loop',
            variant: 'error',
            duration: 3000,
          })
        }
        break
      }
      
      default: {
        props.api.ui.toast({
          message: 'Unknown execution mode',
          variant: 'error',
          duration: 3000,
        })
      }
    }
  }



  const tabIndex = () => executing() ? 2 : editing() ? 1 : 0
  let tabRef: import('@opentui/core').TabSelectRenderable | undefined

  createEffect(() => {
    const idx = tabIndex()
    tabRef?.setSelectedIndex(idx)
  })

  return (
    <box flexDirection="column" paddingX={2}>
      <box flexShrink={0} paddingBottom={1}>
        <tab_select
          ref={(el: import('@opentui/core').TabSelectRenderable) => { tabRef = el }}
          focused={!editing() && !executing()}
          options={[
            { name: 'View', description: 'View plan', value: 'view' },
            { name: 'Edit', description: 'Edit plan', value: 'edit' },
            { name: 'Execute', description: 'Execute plan', value: 'execute' },
            { name: 'Export', description: 'Export to file', value: 'export' },
          ]}
          onSelect={(_, option) => {
            if (!option) return
            switch (option.value) {
              case 'view': setEditing(false); setExecuting(false); break
              case 'edit': setEditing(true); setExecuting(false); break
              case 'execute': setEditing(false); setExecuting(true); break
              case 'export': handleExport(); break
            }
          }}
          showUnderline={false}
          showDescription={false}
          wrapSelection={true}
          tabWidth={10}
          textColor={theme().textMuted}
          focusedTextColor={theme().text}
          selectedTextColor="#ffffff"
          selectedBackgroundColor={theme().borderActive}
        />
      </box>
      
      <Show when={!editing() && !executing()}>
        <scrollbox minHeight={20} maxHeight="75%" borderStyle="rounded" borderColor={theme().border} paddingX={1}>
          <markdown
            content={content()}
            syntaxStyle={SyntaxStyle.create()}
            fg={theme().markdownText}
          />
        </scrollbox>
      </Show>
      
      <Show when={editing()}>
        <textarea
          ref={(value) => {
            textareaRef = value
          }}
          initialValue={content()}
          focused={true}
          minHeight={20}
          maxHeight="75%"
          paddingX={1}
        />
      </Show>
      
      <Show when={executing()}>
        <box flexDirection="column" paddingBottom={1} gap={1} minHeight={20} maxHeight="75%">
          <box paddingBottom={1}>
            <text fg={theme().text}><b>Configure and Run Plan</b></text>
          </box>
          <Show when={defaultsLoaded()} fallback={
            <box flexDirection="column" gap={1} paddingBottom={1}>
              <text fg={theme().textMuted}>Loading...</text>
            </box>
          }>
            <select
              focused={true}
              selectedIndex={0}
              options={[
                {
                  name: `Execution model: ${modelsLoaded() ? getModelDisplayLabel(executionModel(), allModels()) : 'loading...'}`,
                  description: 'Press enter to change',
                  value: 'model:execution',
                },
                {
                  name: `Auditor model: ${modelsLoaded() ? getModelDisplayLabel(auditorModel(), allModels()) : 'loading...'}`,
                  description: 'Press enter to change',
                  value: 'model:auditor',
                },
                ...PLAN_EXECUTION_LABELS.map(label => ({
                  name: label,
                  description: getModeDescription(label),
                  value: `mode:${label}`,
                })),
              ]}
              onSelect={(_, option) => {
                if (option?.value) {
                  if (option.value === 'model:execution') {
                    openModelDialog('execution')
                    return
                  }
                  if (option.value === 'model:auditor') {
                    openModelDialog('auditor')
                    return
                  }
                  if (typeof option.value === 'string' && option.value.startsWith('mode:')) {
                    handleExecuteMode(option.value.slice(5), executionModel(), auditorModel())
                  }
                }
              }}
              showDescription={true}
              itemSpacing={1}
              wrapSelection={true}
              textColor={theme().text}
              focusedTextColor={theme().text}
              selectedTextColor="#ffffff"
              selectedBackgroundColor={theme().borderActive}
              minHeight={16}
              flexGrow={1}
            />
          </Show>
        </box>
      </Show>
      
      <box paddingTop={1} flexShrink={0} flexDirection="row" gap={2}>
        <Show when={editing()}>
          <text fg={theme().success} onMouseUp={handleSave}>Save</text>
        </Show>
        <Show when={executing()}>
          <text fg={theme().textMuted} onMouseUp={() => setExecuting(false)}>Back to plan</text>
        </Show>
        <text fg={theme().textMuted} onMouseUp={() => props.api.ui.dialog.clear()}>Close (esc)</text>
      </box>
    </box>
  )
}

function LoopDetailsDialog(props: { api: TuiPluginApi; loop: LoopInfo; onBack?: () => void; onRefresh?: () => void }) {
  const theme = () => props.api.theme.current
  const [currentLoop, setCurrentLoop] = createSignal<LoopInfo>(props.loop)
  const [stats, setStats] = createSignal<SessionStats | null>(null)
  const [loading, setLoading] = createSignal(true)

  const directory = props.api.state.path.directory
  const pid = getGitProjectId(directory)

  // Re-read loop state when dialog opens and on refresh requests
  // This ensures the dialog shows fresh data, not a stale snapshot
  const refreshLoopState = () => {
    if (pid && currentLoop().name) {
      const freshLoop = readLoopByName(pid, currentLoop().name)
      if (freshLoop) {
        setCurrentLoop(freshLoop)
      }
    }
  }
  
  // Initial refresh on mount
  refreshLoopState()

  createEffect(() => {
    const loop = currentLoop()
    if (loop.sessionId && directory) {
      setLoading(true)
      fetchSessionStats(props.api, loop.sessionId, directory).then((result) => {
        setStats(result)
        setLoading(false)
      }).catch(() => {
        setStats(null)
        setLoading(false)
      })
    } else {
      setLoading(false)
    }
  })

  const handleCancel = () => {
    props.api.ui.dialog.clear()
    const directory = props.api.state.path.directory
    const pid = getGitProjectId(directory)
    if (!pid) return
    const sessionId = cancelLoop(pid, currentLoop().name)
    if (sessionId) {
      props.api.client.session.abort({ sessionID: sessionId }).catch(() => {})
    }
    props.api.ui.toast({
      message: sessionId ? `Cancelled loop: ${currentLoop().name}` : `Loop ${currentLoop().name} is not active`,
      variant: sessionId ? 'success' : 'info',
      duration: 3000,
    })
    // Refresh sidebar immediately after mutation is issued
    props.onRefresh?.()
  }

  const handleRestart = async () => {
    props.api.ui.dialog.clear()
    const directory = props.api.state.path.directory
    const pid = getGitProjectId(directory)
    if (!pid) return
    const newSessionId = await restartLoop(pid, currentLoop().name, props.api)
    const label = currentLoop().active ? 'Force restarting' : 'Restarting'
    props.api.ui.toast({
      message: newSessionId ? `${label} loop: ${currentLoop().name}` : `Failed to restart loop: ${currentLoop().name}`,
      variant: newSessionId ? 'success' : 'error',
      duration: 3000,
    })
    // Refresh sidebar immediately after mutation is issued
    props.onRefresh?.()
  }

  const statusBadge = () => {
    const loop = currentLoop()
    if (loop.active) return { text: loop.phase, color: loop.phase === 'auditing' ? theme().warning : theme().success }
    if (loop.terminationReason === 'completed') return { text: 'completed', color: theme().success }
    if (loop.terminationReason === 'cancelled' || loop.terminationReason === 'user_aborted') return { text: 'cancelled', color: theme().textMuted }
    return { text: 'ended', color: theme().error }
  }

  return (
    <box flexDirection="column" paddingX={2}>
      <box flexDirection="column" flexShrink={0}>
        <box flexDirection="row" gap={1} alignItems="center">
          <text fg={theme().text}>
            <b>{currentLoop().name}</b>
          </text>
          <text fg={statusBadge().color}>
            <b>[{statusBadge().text}]</b>
          </text>
        </box>
        <box>
          <text fg={theme().textMuted}>
            Iteration {currentLoop().iteration}{currentLoop().maxIterations > 0 ? `/${currentLoop().maxIterations}` : ''}
          </text>
        </box>
      </box>

      <Show when={loading()}>
        <box paddingTop={1}>
          <text fg={theme().textMuted}>Loading stats...</text>
        </box>
      </Show>

      <Show when={!loading()}>
        <box flexDirection="column" paddingTop={1} flexShrink={0}>
          <Show when={stats()} fallback={
            <box>
              <text fg={theme().textMuted}>Session stats unavailable</text>
            </box>
          }>
            <box flexDirection="column">
              <box>
                <text fg={theme().text}>
                  <span style={{ fg: theme().textMuted }}>Session: </span>
                  {currentLoop().sessionId.slice(0, 8)}...
                </text>
              </box>
              <box>
                <text fg={theme().text}>
                  <span style={{ fg: theme().textMuted }}>Phase: </span>
                  {currentLoop().phase}
                </text>
              </box>
              <Show when={currentLoop().executionModel}>
                <box>
                  <text fg={theme().text}>
                    <span style={{ fg: theme().textMuted }}>Execution model: </span>
                    {currentLoop().executionModel}
                  </text>
                </box>
              </Show>
              <Show when={currentLoop().auditorModel}>
                <box>
                  <text fg={theme().text}>
                    <span style={{ fg: theme().textMuted }}>Auditor model: </span>
                    {currentLoop().auditorModel}
                  </text>
                </box>
              </Show>
              <box>
                <text fg={theme().text}>
                  <span style={{ fg: theme().textMuted }}>Messages: </span>
                  {stats()!.messages.total} total ({stats()!.messages.assistant} assistant)
                </text>
              </box>
              <box>
                <text fg={theme().text}>
                  <span style={{ fg: theme().textMuted }}>Tokens: </span>
                  {formatTokens(stats()!.tokens.input)} in / {formatTokens(stats()!.tokens.output)} out / {formatTokens(stats()!.tokens.reasoning)} reasoning
                </text>
              </box>
              <box>
                <text fg={theme().text}>
                  <span style={{ fg: theme().textMuted }}>Cost: </span>
                  ${stats()!.cost.toFixed(4)}
                </text>
              </box>
              <Show when={stats()!.fileChanges}>
                <box>
                  <text fg={theme().text}>
                    <span style={{ fg: theme().textMuted }}>Files: </span>
                    {stats()!.fileChanges!.files} changed (+{stats()!.fileChanges!.additions}/-{stats()!.fileChanges!.deletions})
                  </text>
                </box>
              </Show>
              <Show when={stats()!.timing}>
                <box>
                  <text fg={theme().text}>
                    <span style={{ fg: theme().textMuted }}>Duration: </span>
                    {formatDuration(stats()!.timing!.durationMs, { includeSeconds: true, compact: true })}
                  </text>
                </box>
              </Show>
            </box>
          </Show>
        </box>
      </Show>

      <Show when={stats()?.lastActivity?.summary}>
        <box flexDirection="column" paddingTop={1} flexGrow={1} flexShrink={1}>
          <box flexShrink={0}>
            <text fg={theme().text}><b>Latest Output</b></text>
          </box>
          <scrollbox maxHeight={12} borderStyle="rounded" borderColor={theme().border} paddingX={1}>
            <text fg={theme().textMuted} wrapMode="word">
              {truncate(stats()!.lastActivity!.summary, 500)}
            </text>
          </scrollbox>
        </box>
      </Show>

      <box paddingTop={1} flexShrink={0} flexDirection="row" gap={2} paddingY={2}>
        <Show when={props.onBack}>
          <text fg={theme().textMuted} onMouseUp={() => props.onBack!()}>Back</text>
        </Show>
        <Show when={currentLoop().sessionId && currentLoop().workspaceId}>
          <text fg={theme().success} onMouseUp={() => {
            props.api.route.navigate('session', { sessionID: currentLoop().sessionId })
          }}>Open session</text>
        </Show>
        <Show when={currentLoop().active}>
          <text fg={theme().warning} onMouseUp={handleRestart}>Force Restart</text>
          <text fg={theme().error} onMouseUp={handleCancel}>Cancel loop</text>
        </Show>
        <Show when={!currentLoop().active && currentLoop().terminationReason !== 'completed'}>
          <text fg={theme().success} onMouseUp={handleRestart}>Restart</text>
        </Show>
        <text fg={theme().textMuted} onMouseUp={() => props.api.ui.dialog.clear()}>Close (esc)</text>
      </box>
    </box>
  )
}

function Sidebar(props: { api: TuiPluginApi; opts: TuiOptions; sessionId?: string }) {
  const [open, setOpen] = createSignal(true)
  const [loops, setLoops] = createSignal<LoopInfo[]>([])
  const [hasPlan, setHasPlan] = createSignal(false)
  const [graphStatusFormatted, setGraphStatusFormatted] = createSignal<ReturnType<typeof formatGraphStatus> | null>(null)
  const [graphStatusRaw, setGraphStatusRaw] = createSignal<ReturnType<typeof readGraphStatus> | null>(null)
  const theme = () => props.api.theme.current
  const directory = props.api.state.path.directory
  const pid = getGitProjectId(directory)

  const title = createMemo(() => {
    return props.opts.showVersion ? `Forge v${VERSION}` : 'Forge'
  })

  const dot = (loop: LoopInfo) => {
    if (!loop.active) {
      if (loop.terminationReason === 'completed') return theme().success
      if (loop.terminationReason === 'cancelled' || loop.terminationReason === 'user_aborted') return theme().textMuted
      return theme().error
    }
    if (loop.phase === 'auditing') return theme().warning
    return theme().success
  }

  const statusText = (loop: LoopInfo) => {
    const max = loop.maxIterations > 0 ? `/${loop.maxIterations}` : ''
    if (loop.active) return `${loop.phase} · iter ${loop.iteration}${max}`
    if (loop.terminationReason === 'completed') return `completed · ${loop.iteration} iter${loop.iteration !== 1 ? 's' : ''}`
    return loop.terminationReason?.replace(/_/g, ' ') ?? 'ended'
  }

  /**
   * Refreshes all sidebar-visible data: loops, plan presence, and graph status.
   * This is the single source of truth for sidebar state updates.
   * 
   * Triggers:
   * - session.status events
   * - Loop/plan mutation actions (save, delete, execute, cancel, restart)
   * - Periodic polling for active worktree loops (5s interval)
   * - Periodic polling for transient graph states (5s interval)
   * - Manual onRefresh callbacks from dialogs
   */
  const redirectedSessions = new Set<string>()

  function refreshSidebarData() {
    if (!pid) return
    
    // Refresh loop states from KV
    const states = readLoopStates(pid)
    const cutoff = Date.now() - 5 * 60 * 1000
    const visible = states.filter(l => 
      l.active || (l.completedAt && new Date(l.completedAt).getTime() > cutoff)
    )
    visible.sort((a, b) => {
      if (a.active && !b.active) return -1
      if (!a.active && b.active) return 1
      const aTime = a.completedAt ?? a.startedAt ?? ''
      const bTime = b.completedAt ?? b.startedAt ?? ''
      return bTime.localeCompare(aTime)
    })
    setLoops(visible)
    
    // Refresh plan presence for current session
    if (props.sessionId) {
      const plan = readPlan(pid, props.sessionId)
      setHasPlan(plan !== null)
    }
    
    // Auto-redirect if the currently-viewed session belongs to a loop that just completed
    if (props.sessionId && !redirectedSessions.has(props.sessionId)) {
      const ended = states.find(l =>
        l.sessionId === props.sessionId
        && !l.active
        && l.terminationReason === 'completed'
        && l.worktree
        && l.hostSessionId,
      )
      if (ended) {
        redirectedSessions.add(props.sessionId)
        try {
          props.api.route.navigate('session', { sessionID: ended.hostSessionId! })
          props.api.ui.toast({
            message: `Loop "${ended.name}" completed · click Forge sidebar to review`,
            variant: 'success',
            duration: 5000,
          })
        } catch (err) {
          console.error('[forge] sidebar: failed to redirect after loop completion', err)
        }
      }
    }
    
    // Refresh graph status from KV (scoped to current directory)
    const status = readGraphStatus(pid, undefined, directory)
    setGraphStatusRaw(status)
    setGraphStatusFormatted(formatGraphStatus(status))
  }
  

  
  const unsubStatus = props.api.event.on('session.status', () => {
    refreshSidebarData()
  })
  // session.deleted fires when terminateLoop cleans up a completed worktree loop's session,
  // session.updated fires on status transitions. Both should refresh the sidebar immediately
  // so completed loops don't keep their stale sessionId/workspaceId in the list.
  const unsubDeleted = props.api.event.on('session.deleted', () => {
    refreshSidebarData()
  })
  const unsubUpdated = props.api.event.on('session.updated', () => {
    refreshSidebarData()
  })

  let pollTimer: ReturnType<typeof setInterval> | null = null

  function startPolling() {
    if (pollTimer) return
    pollTimer = setInterval(() => {
      refreshSidebarData()
    }, 5000)
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  refreshSidebarData()

  // Re-check after a short delay to catch graph status that wasn't written yet at mount time
  const initTimer = setTimeout(() => {
    if (!graphStatusRaw()) {
      refreshSidebarData()
    }
  }, 2000)

  createEffect(() => {
    if (shouldPollSidebar(loops(), graphStatusRaw())) {
      startPolling()
    } else {
      stopPolling()
    }
  })

  onCleanup(() => {
    unsubStatus()
    unsubDeleted()
    unsubUpdated()
    stopPolling()
    clearTimeout(initTimer)
  })

  const hasContent = createMemo(() => {
    if (hasPlan()) return true
    if (props.opts.showLoops && loops().length > 0) return true
    if (graphStatusFormatted()) return true
    return false
  })
  
  const activeCount = createMemo(() => {
    return loops().filter(l => l.active).length
  })

  return (
    <Show when={props.opts.sidebar}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => hasContent() && setOpen((x) => !x)}>
          <Show when={hasContent()}>
            <text fg={theme().text}>{open() ? '▼' : '▶'}</text>
          </Show>
          <text fg={theme().text}>
            <b>{title()}</b>
            {!open() && hasPlan() ? <span style={{ fg: theme().info }}> · plan</span> : ''}
            {!open() && graphStatusFormatted() && graphStatusFormatted()!.text.includes('ready') ? <span style={{ fg: theme().success }}> · ready</span> : ''}
            {!open() && activeCount() > 0 ? <span style={{ fg: theme().textMuted }}>{` (${activeCount()} active)`}</span> : ''}
          </text>
        </box>
        <Show when={open()}>
          <Show when={hasPlan()}>
            <box
              flexDirection="row"
              gap={1}
              onMouseUp={() => {
                if (!pid || !props.sessionId) return
                const plan = readPlan(pid, props.sessionId)
                if (!plan) {
                  props.api.ui.toast({ message: 'Plan not found', variant: 'info', duration: 3000 })
                  return
                }
                const refreshSidebar = refreshSidebarData
                props.api.ui.dialog.setSize("xlarge")
                props.api.ui.dialog.replace(() => (
                  <PlanViewerDialog api={props.api} planContent={plan} projectId={pid} sessionId={props.sessionId!} onRefresh={refreshSidebar} />
                ))
              }}
            >
              <text flexShrink={0} style={{ fg: theme().info }}>📋</text>
              <text fg={theme().text}>Plan</text>
            </box>
          </Show>
          <Show when={graphStatusFormatted()}>
            <box
              flexDirection="row"
              gap={1}
            >
              <text flexShrink={0} style={{ fg: theme()[graphStatusFormatted()!.color] }}>•</text>
              <text fg={theme().text} wrapMode="word">
                {graphStatusFormatted()!.text}
              </text>
            </box>
          </Show>
          <Show when={props.opts.showLoops && loops().length > 0}>
            <For each={loops()}>
              {(loop) => (
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseUp={() => {
                    // Completed/terminated loops: always show the details dialog.
                    // Their session and workspace may have been deleted during cleanup,
                    // so navigating to loop.sessionId would land on a dead session.
                    // Workspace-backed active worktree loop: navigate directly to its session.
                    // Legacy active worktree loop (no workspaceId): open the details dialog.
                    // Active in-place loop: navigate directly.
                    if (!loop.active) {
                      props.api.ui.dialog.setSize("medium")
                      props.api.ui.dialog.replace(() => (
                        <LoopDetailsDialog api={props.api} loop={loop} onRefresh={refreshSidebarData} />
                      ))
                    } else if (loop.worktree && loop.workspaceId && loop.sessionId) {
                      props.api.route.navigate('session', { sessionID: loop.sessionId })
                    } else if (loop.worktree) {
                      props.api.ui.dialog.setSize("medium")
                      props.api.ui.dialog.replace(() => (
                        <LoopDetailsDialog api={props.api} loop={loop} onRefresh={refreshSidebarData} />
                      ))
                    } else {
                      props.api.route.navigate('session', { sessionID: loop.sessionId })
                    }
                  }}
                >
                  <text flexShrink={0} style={{ fg: dot(loop) }}>•</text>
                  <text fg={theme().text} wrapMode="word">
                    {truncateMiddle(loop.name, 25)}{' '}
                    <span style={{ fg: theme().textMuted }}>{statusText(loop)}</span>
                  </text>
                </box>
              )}
            </For>
          </Show>
        </Show>
      </box>
    </Show>
  )
}

const id = 'oc-forge'

// Export helper functions for testing
export { readLoopStates, readLoopByName }

const tui: TuiPlugin = async (api) => {

  const tuiConfig = loadTuiConfig()
  const opts: TuiOptions = {
    sidebar: tuiConfig?.sidebar ?? true,
    showLoops: tuiConfig?.showLoops ?? true,
    showVersion: tuiConfig?.showVersion ?? true,
    keybinds: { ...DEFAULT_KEYBINDS, ...tuiConfig?.keybinds },
  }

  if (!opts.sidebar) return

  api.command.register(() => {
    const directory = api.state.path.directory
    const pid = getGitProjectId(directory)
    if (!pid) return []

    const states = readLoopStates(pid)
    if (states.length === 0) return []

    return [
      {
        title: 'Forge: Show loops',
        value: 'forge.loops.show',
        description: `${states.length} loop${states.length !== 1 ? 's' : ''}`,
        category: 'Forge',
        keybind: opts.keybinds.showLoops,
        onSelect: () => {
          const worktreeLoops = states.filter(l => l.worktree)
          const loopOptions = worktreeLoops.map(l => {
            const status = l.active
              ? l.phase
              : l.terminationReason?.replace(/_/g, ' ') ?? 'ended'

            return {
              title: l.name,
              value: l.name,
              description: status,
            }
          })

          const showLoopList = () => {
            api.ui.dialog.setSize("large")
            api.ui.dialog.replace(() => (
              <api.ui.DialogSelect
                title="Loops"
                options={loopOptions}
                onSelect={(opt) => {
                  const loopName = opt.value as string
                  // Re-read fresh loop state from KV when opening details
                  // This ensures command-driven dialogs use fresh data, not the initial snapshot
                  const freshLoop = pid ? readLoopByName(pid, loopName) : null
                  if (freshLoop) {
                    api.ui.dialog.setSize("medium")
                    api.ui.dialog.replace(() => (
                      <LoopDetailsDialog api={api} loop={freshLoop} onBack={showLoopList} onRefresh={() => {}} />
                    ))
                  } else {
                    api.ui.dialog.clear()
                  }
                }}
              />
            ))
          }

          showLoopList()
        },
      },
    ]
  })

  api.command.register(() => {
    const route = api.route.current
    if (route.name !== 'session') return []

    const directory = api.state.path.directory
    const pid = getGitProjectId(directory)
    if (!pid) return []

    const sessionID = (route as { params: { sessionID: string } }).params.sessionID

    const refreshSidebar = () => {
      // Trigger sidebar refresh via session status event
    }

    return [{
      title: 'Forge: View plan',
      value: 'forge.plan.view',
      description: 'View cached plan for this session',
      category: 'Forge',
      keybind: opts.keybinds.viewPlan,
      onSelect: () => {
        const freshPlan = readPlan(pid, sessionID)
        if (!freshPlan) {
          api.ui.toast({ message: 'No plan found for this session', variant: 'info', duration: 3000 })
          return
        }
        api.ui.dialog.setSize("xlarge")
        api.ui.dialog.replace(() => (
          <PlanViewerDialog api={api} planContent={freshPlan} projectId={pid} sessionId={sessionID} onRefresh={refreshSidebar} />
        ))
      },
    }, {
      title: 'Forge: Execute plan',
      value: 'forge.plan.execute',
      description: 'Execute cached plan',
      category: 'Forge',
      keybind: opts.keybinds.executePlan,
      onSelect: () => {
        const freshPlan = readPlan(pid, sessionID)
        if (!freshPlan) {
          api.ui.toast({ message: 'No plan found for this session', variant: 'info', duration: 3000 })
          return
        }
        api.ui.dialog.setSize("xlarge")
        api.ui.dialog.replace(() => (
          <PlanViewerDialog api={api} planContent={freshPlan} projectId={pid} sessionId={sessionID} onRefresh={refreshSidebar} startInExecuteMode={true} />
        ))
      },
    }]
  })

  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(_ctx, slotProps) {
        return <Sidebar api={api} opts={opts} sessionId={slotProps.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }

export default plugin
