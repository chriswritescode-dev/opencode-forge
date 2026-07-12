import { resolveRemoteServer, listRemoteNames, forgeSyncRef } from './remote-config'
import { defaultGitService, type GitService } from './git-service'
import { createRemoteForgeClient, type RemoteClientOptions } from '../client/sdk-adapter'
import type { ForgeClient } from '../client/port'
import type { PluginConfig } from '../types'
import { reserveTuiLoopName, launchTuiLoop } from './tui-client'

export interface RemoteLoopRequest {
  remoteName: string
  localDirectory: string
  /**
   * The local repo's OpenCode project id (as resolved by the local opencode
   * server). Used to match the remote project by identity rather than by
   * worktree path, which differs per machine.
   */
  localProjectId: string
  title: string
  loopName: string
  plan: string
  executionModel?: string
  auditorModel?: string
  executionVariant?: string
  auditorVariant?: string
}

export interface RemoteLaunchDeps {
  config: PluginConfig
  git?: GitService
  createClient?: (opts: RemoteClientOptions) => ForgeClient
  onWarning?: (message: string) => void
  debug?: (message: string) => void
}

export type RemoteLaunchResult =
  | { loopName: string; sessionId: string; remoteName: string }
  | { error: string }

export async function executeRemoteLoop(
  req: RemoteLoopRequest,
  deps: RemoteLaunchDeps,
): Promise<RemoteLaunchResult> {
  const debug = deps.debug ?? (() => {})
  const git = deps.git ?? defaultGitService
  const createClient = deps.createClient ?? createRemoteForgeClient

  debug(`remote-launch: start remote="${req.remoteName}" dir="${req.localDirectory}" projectId="${req.localProjectId}" loop="${req.loopName}"`)

  // 1. Resolve remote server
  const remote = resolveRemoteServer(deps.config, req.remoteName)
  if (!remote) {
    const names = listRemoteNames(deps.config)
    return { error: `Unknown remote "${req.remoteName}". Configured remotes: ${names.length ? names.join(', ') : '(none)'}` }
  }
  debug(`remote-launch: resolved remote name="${remote.name}" url="${remote.url}" gitRemote="${remote.gitRemote}" sandbox=${remote.sandbox}`)

  // 2. Preflight git checks
  if (!git.isInsideWorkTree(req.localDirectory)) {
    return { error: `Not a git repository: ${req.localDirectory}` }
  }

  const headResult = git.revParseHead(req.localDirectory)
  if (!headResult.ok) {
    return { error: `Failed to resolve HEAD in ${req.localDirectory}: ${headResult.stderr}` }
  }
  const sha = headResult.stdout.trim()
  debug(`remote-launch: preflight ok HEAD=${sha}`)

  // Warn about dirty working tree but proceed
  const statusResult = git.statusPorcelain(req.localDirectory)
  if (statusResult.ok && statusResult.stdout.trim().length > 0) {
    deps.onWarning?.(`Uncommitted changes are not included; remote loop starts from HEAD ${sha.substring(0, 7)}`)
  }

  // 3. Discovery: find the remote project sharing this repo's OpenCode project
  // identity. OpenCode derives the same id for a given repo on every server
  // (normalized git-origin hash, else the first root commit), so matching on
  // id is location-independent — unlike worktree paths, which differ per
  // machine (e.g. a local checkout vs. a container workspace).
  if (!req.localProjectId) {
    return { error: `Could not resolve the local OpenCode project id for ${req.localDirectory}; cannot match a remote project.` }
  }

  const discoveryClient = createClient({
    url: remote.url,
    username: remote.username,
    password: remote.password,
  })

  let projects: Array<{ id: string; worktree: string }>
  debug(`remote-launch: listing projects on "${remote.name}"`)
  try {
    projects = (await discoveryClient.project.list()) as Array<{ id: string; worktree: string }>
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err)
    debug(`remote-launch: project.list FAILED: ${msg}`)
    return { error: `Failed to list projects on remote "${remote.name}": ${err instanceof Error ? err.message : String(err)}` }
  }
  debug(`remote-launch: project.list returned ${projects.length} project(s)`)

  const matched = projects.find((p) => p.id === req.localProjectId)
  if (!matched) {
    const ids = projects.map((p) => p.id)
    debug(`remote-launch: no id match for ${req.localProjectId}; available=${ids.length ? ids.join(',') : '(none)'}`)
    return { error: `No project on remote "${remote.name}" matches OpenCode project id ${req.localProjectId}. Available project ids: ${ids.length ? ids.join(', ') : '(none)'}` }
  }
  debug(`remote-launch: matched project id=${matched.id} worktree="${matched.worktree}"`)

  // 4. Create scoped client for the matched directory
  const remoteClient = createClient({
    url: remote.url,
    username: remote.username,
    password: remote.password,
    directory: matched.worktree,
  })

  // 5. Reserve a unique loop name (once; launchTuiLoop uses it verbatim below)
  const finalLoopName = await reserveTuiLoopName(remoteClient, null, req.loopName)
  const syncRef = forgeSyncRef(finalLoopName)
  debug(`remote-launch: reserved loop name="${finalLoopName}" syncRef="${syncRef}"`)

  // 6. Push HEAD to remote ref
  debug(`remote-launch: pushing HEAD:${syncRef} to gitRemote="${remote.gitRemote}" from "${req.localDirectory}"`)
  const pushResult = git.push(req.localDirectory, remote.gitRemote, `HEAD:${syncRef}`, true)
  if (!pushResult.ok) {
    debug(`remote-launch: push FAILED: ${pushResult.stderr || '(no stderr)'}`)
    return { error: `Failed to push to remote "${remote.name}": ${pushResult.stderr || '(no stderr)'}` }
  }
  debug(`remote-launch: push ok (ref ${syncRef} now on ${remote.gitRemote})`)

  // 7. Launch the remote loop
  const launchResult = await launchTuiLoop({
    client: remoteClient,
    directory: matched.worktree,
    projectId: matched.id,
    requestedLoopName: finalLoopName,
    loopNameReserved: true,
    connectPollIntervalMs: 500,
    title: req.title,
    plan: req.plan,
    executionModel: req.executionModel,
    auditorModel: req.auditorModel,
    executionVariant: req.executionVariant,
    auditorVariant: req.auditorVariant,
    extraWorkspaceFields: {
      startRef: sha,
      syncRef,
      gitRemote: remote.gitRemote,
    },
    forgeLoopOverrides: {
      sandboxEnabled: remote.sandbox,
    },
    debug,
  })

  if ('error' in launchResult) {
    debug(`remote-launch: launchTuiLoop FAILED: ${launchResult.error}`)
    const cleanup = git.push(req.localDirectory, remote.gitRemote, `:${syncRef}`, false)
    debug(`remote-launch: sync ref cleanup ${cleanup.ok ? 'ok' : `failed: ${cleanup.stderr.trim() || 'unknown error'}`}`)
    return { error: launchResult.error }
  }

  debug(`remote-launch: launched loop="${launchResult.loopName}" session=${launchResult.sessionId} on "${remote.name}"`)
  return {
    loopName: launchResult.loopName,
    sessionId: launchResult.sessionId,
    remoteName: remote.name,
  }
}
