/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from '@opencode-ai/plugin/tui'
import { createEffect, createMemo, createSignal, onCleanup, Show, For } from 'solid-js'
import { SyntaxStyle, type TextareaRenderable } from '@opentui/core'
import { readFileSync, existsSync, writeFileSync } from 'fs'
import { homedir, platform } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'
import { Database } from 'bun:sqlite'
import { VERSION } from './version'
import { resolveDataDir } from './storage'
import { fetchSessionStats, type SessionStats } from './utils/session-stats'
import { slugify } from './utils/logger'
import { extractPlanTitle, PLAN_EXECUTION_LABELS, matchExecutionLabel } from './utils/plan-execution'
import { launchFreshLoop } from './utils/loop-launch'
import { readPlan, writePlan, deletePlan } from './utils/tui-plan-store'
import { readGraphStatus, formatGraphStatus } from './utils/tui-graph-status'
import { readLoopStates, readLoopByName, shouldPollSidebar, type LoopInfo } from './utils/tui-refresh-helpers'

import { buildLoopPermissionRuleset } from './constants/loop'
import { agents } from './agents'

type TuiOptions = {
  sidebar: boolean
  showLoops: boolean
  showVersion: boolean
}

type TuiConfig = {
  sidebar?: boolean
  showLoops?: boolean
  showVersion?: boolean
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

function resolveProjectId(directory: string): string | null {
  const cachePath = join(directory, '.git', 'opencode')
  if (existsSync(cachePath)) {
    try {
      const id = readFileSync(cachePath, 'utf-8').trim()
      if (id) return id
    } catch {}
  }
  try {
    const output = execSync('git rev-list --max-parents=0 --all', { cwd: directory, encoding: 'utf-8' }).trim()
    const commits = output.split('\n').filter(Boolean).sort()
    if (commits[0]) return commits[0]
  } catch {}
  return null
}





function cancelLoop(projectId: string, loopName: string): string | null {
  const dbPath = join(resolveDataDir(), 'graph.db')

  if (!existsSync(dbPath)) return null

  let db: Database | null = null
  try {
    db = new Database(dbPath)
    const key = `loop:${loopName}`
    const now = Date.now()
    const row = db.prepare('SELECT data, project_id FROM project_kv WHERE project_id = ? AND key = ? AND expires_at > ?').get(projectId, key, now) as { data: string; project_id: string } | null
    if (!row) return null

    const state = JSON.parse(row.data)
    if (!state.active) return null

    const updatedState = {
      ...state,
      active: false,
      completedAt: new Date().toISOString(),
      terminationReason: 'cancelled',
    }
    db.prepare('UPDATE project_kv SET data = ?, updated_at = ? WHERE project_id = ? AND key = ?').run(
      JSON.stringify(updatedState),
      now,
      projectId,
      key,
    )
    return state.sessionId ?? null
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
    const key = `loop:${loopName}`
    const now = Date.now()
    const row = db.prepare('SELECT data, project_id FROM project_kv WHERE project_id = ? AND key = ? AND expires_at > ?').get(projectId, key, now) as { data: string; project_id: string } | null
    if (!row) return null

    const state = JSON.parse(row.data)
    
    if (state.active) {
      try { await api.client.session.abort({ sessionID: state.sessionId }) } catch {}
      const oldSessionKey = `loop-session:${state.sessionId}`
      db.prepare('DELETE FROM project_kv WHERE project_id = ? AND key = ?').run(projectId, oldSessionKey)
    }

    const directory = state.worktreeDir
    if (!directory) return null
    
    // Load config and resolve log target for permission ruleset
    const { loadPluginConfig } = await import('./setup')
    const { resolveWorktreeLogTarget } = await import('./services/worktree-log')
    const config = loadPluginConfig()
    const dataDir = resolveDataDir()
    const logTarget = resolveWorktreeLogTarget(config, {
      projectDir: state.projectDir || state.worktreeDir,
      sandboxHostDir: directory,
      sandbox: state.sandbox,
      dataDir,
    })
    const agentExclusions = agents.code.tools?.exclude
    const permissionRuleset = buildLoopPermissionRuleset(config, logTarget?.permissionPath ?? null, {
      isWorktree: !!state.worktree,
      agentExclusions,
    })
    const createResult = await api.client.session.create({ directory, title: loopName, permission: permissionRuleset })
    if (createResult.error || !createResult.data) return null
    
    const newSessionId = createResult.data.id

    const sessionKey = `loop-session:${newSessionId}`
    const ttl = 30 * 24 * 60 * 60 * 1000
    db.prepare('INSERT OR REPLACE INTO project_kv (project_id, key, data, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
      projectId, sessionKey, JSON.stringify(loopName), now + ttl, now
    )

    const newState = {
      ...state,
      active: true,
      sessionId: newSessionId,
      phase: 'coding',
      errorCount: 0,
      auditCount: 0,
      startedAt: new Date().toISOString(),
      completedAt: undefined,
      terminationReason: undefined,
      projectDir: state.projectDir || state.worktreeDir,
    }
    db.prepare('UPDATE project_kv SET data = ?, updated_at = ? WHERE project_id = ? AND key = ?').run(
      JSON.stringify(newState), now, projectId, key
    )

    let promptText = state.prompt ?? ''
    if (state.completionSignal) {
      const completionInstructions = `\n\n---\n\n**IMPORTANT - Completion Signal:** When you have completed ALL phases of this plan successfully, you MUST output the following phrase exactly: ${state.completionSignal}\n\nBefore outputting the completion signal, you MUST:\n1. Verify each phase's acceptance criteria are met\n2. Run all verification commands listed in the plan and confirm they pass\n3. If tests were required, confirm they exist AND pass\n\nDo NOT output this phrase until every phase is truly complete and all verification steps pass. The loop will continue until this signal is detected.`
      promptText += completionInstructions
    }

    await api.client.session.promptAsync({
      sessionID: newSessionId,
      directory,
      parts: [{ type: 'text' as const, text: promptText }],
      agent: 'code',
    })

    return newSessionId
  } catch {
    return null
  } finally {
    try { db?.close() } catch {}
  }
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
}

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / (1000 * 60 * 60))
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60))
  const seconds = Math.floor((ms % (1000 * 60)) / 1000)
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`
  }
  return `${seconds}s`
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength - 3) + '...'
}

function truncateMiddle(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  const keep = maxLength - 5
  const start = Math.ceil(keep / 2)
  const end = Math.floor(keep / 2)
  return text.slice(0, start) + '.....' + text.slice(text.length - end)
}

function PlanViewerDialog(props: {
  api: TuiPluginApi
  planContent: string
  projectId: string
  sessionId: string
  onRefresh?: () => void
}) {
  const theme = () => props.api.theme.current
  const [editing, setEditing] = createSignal(false)
  const [executing, setExecuting] = createSignal(false)
  const [content, setContent] = createSignal(props.planContent)
  let textareaRef: TextareaRenderable | undefined

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

  const handleExecuteMode = async (mode: string) => {
    const planText = content()
    const title = extractPlanTitle(planText)
    const directory = props.api.state.path.directory
    const pid = resolveProjectId(directory)
    
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
          
          await props.api.client.session.promptAsync({
            sessionID: newSessionId,
            directory,
            agent: 'code',
            parts: [{ type: 'text' as const, text: planText }],
          })
          
          props.api.ui.toast({
            message: `New session created: ${title}`,
            variant: 'success',
            duration: 3000,
          })
          
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
          await props.api.client.session.promptAsync({
            sessionID: props.sessionId,
            directory,
            agent: 'code',
            parts: [{ type: 'text' as const, text: inPlacePrompt }],
          })
          
          props.api.ui.toast({
            message: 'Executing plan in current session',
            variant: 'success',
            duration: 3000,
          })
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
          })
          
          if (launchResult) {
            // Delete plan from old session after successful launch
            if (pid) {
              deletePlan(pid, props.sessionId)
            }
            
            // Use the actual loop name returned by the launcher
            props.api.ui.toast({
              message: isWorktree ? `Loop started in worktree: ${launchResult.loopName}` : `Loop started: ${launchResult.loopName}`,
              variant: 'success',
              duration: 3000,
            })
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



  return (
    <box flexDirection="column" paddingX={2}>
      <box flexShrink={0} paddingBottom={1} flexDirection="row" gap={2}>
        <text fg={theme().text}><b>Plan</b></text>
        <text 
          fg={executing() ? theme().textMuted : editing() ? theme().text : theme().info} 
          onMouseUp={() => { setEditing(false); setExecuting(false) }}
        >
          [view]
        </text>
        <text 
          fg={editing() ? theme().text : theme().textMuted} 
          onMouseUp={() => { setEditing(true); setExecuting(false) }}
        >
          [edit]
        </text>
        <text 
          fg={executing() ? theme().text : theme().textMuted} 
          onMouseUp={() => { setEditing(false); setExecuting(true) }}
        >
          [execute]
        </text>
        <text 
          fg={theme().textMuted} 
          onMouseUp={handleExport}
        >
          [export]
        </text>
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
            <text fg={theme().text}><b>Select Execution Mode</b></text>
          </box>
            <select
              focused={true}
              options={PLAN_EXECUTION_LABELS.map(label => ({
                name: label,
                description: getModeDescription(label),
                value: label,
              }))}
              onSelect={(_, option) => {
                if (option?.value) {
                  handleExecuteMode(option.value)
                }
              }}
              showDescription={false}
              itemSpacing={1}
              wrapSelection={true}
              textColor={theme().text}
              focusedTextColor={theme().text}
              selectedTextColor="#ffffff"
              selectedBackgroundColor={theme().borderActive}
              minHeight={12}
              flexGrow={1}
            />
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
  const pid = resolveProjectId(directory)

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
    const pid = resolveProjectId(directory)
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
    const pid = resolveProjectId(directory)
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
                    {formatDuration(stats()!.timing!.durationMs)}
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
  const pid = resolveProjectId(directory)

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
    
    // Refresh graph status from KV (scoped to current directory)
    const status = readGraphStatus(pid, undefined, directory)
    setGraphStatusRaw(status)
    setGraphStatusFormatted(formatGraphStatus(status))
  }
  

  
  const unsub = props.api.event.on('session.status', () => {
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
    unsub()
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
                    if (loop.worktree) {
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
  }

  if (!opts.sidebar) return

  api.command.register(() => {
    const directory = api.state.path.directory
    const pid = resolveProjectId(directory)
    if (!pid) return []

    const states = readLoopStates(pid)
    if (states.length === 0) return []

    return [
      {
        title: 'Forge: Show loops',
        value: 'forge.loops.show',
        description: `${states.length} loop${states.length !== 1 ? 's' : ''}`,
        category: 'Forge',
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
    const pid = resolveProjectId(directory)
    if (!pid) return []

    const sessionID = (route.params as { sessionID?: string })?.sessionID
    if (!sessionID) return []

    const plan = readPlan(pid, sessionID)
    if (!plan) return []

    return [{
      title: 'Forge: View plan',
      value: 'forge.plan.view',
      description: 'View cached plan for this session',
      category: 'Forge',
      onSelect: () => {
        const freshPlan = readPlan(pid, sessionID)
        if (!freshPlan) {
          api.ui.toast({ message: 'No plan found for this session', variant: 'info', duration: 3000 })
          return
        }
        api.ui.dialog.setSize("large")
        api.ui.dialog.replace(() => (
          <PlanViewerDialog api={api} planContent={freshPlan} projectId={pid} sessionId={sessionID} />
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
