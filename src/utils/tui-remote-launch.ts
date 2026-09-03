import { resolveRemoteServer, listRemoteNames, forgeSyncRef, type ResolvedRemoteServer } from './remote-config'
import { defaultGitService, type GitService, type GitResult } from './git-service'
import { createRemoteForgeClient, type RemoteClientOptions } from '../client/sdk-adapter'
import type { ForgeClient } from '../client/port'
import type { PluginConfig } from '../types'
import { resolveRemoteLoopPermissionOptions } from '../constants/loop'
import { emitLoopPermissionConfigWarnings } from './loop-permission-warnings'
import { resolveDataDir } from './opencode-paths'
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

export type ConnectRemoteProjectResult =
  | { remote: ResolvedRemoteServer; project: { id: string; worktree: string }; client: ForgeClient }
  | { error: string }

export interface ConnectRemoteProjectDeps
  extends Pick<RemoteLaunchDeps, 'config' | 'createClient' | 'debug'> {
  /**
   * Local preflight gate (e.g. git checks) run after the remote is resolved
   * but before any network call, so a caller can keep its error precedence.
   */
  beforeDiscovery?: () => { error: string } | void
}

/**
 * Shared remote-connection steps: resolve the configured remote server,
 * discover the remote project matching the local OpenCode project id, and
 * create the scoped client for the matched worktree.
 */
export async function connectRemoteProject(
  req: { remoteName: string; localProjectId: string; localDirectory?: string },
  deps: ConnectRemoteProjectDeps,
): Promise<ConnectRemoteProjectResult> {
  const debug = deps.debug ?? (() => {})

  // 1. Resolve remote server
  const remote = resolveRemoteServer(deps.config, req.remoteName)
  if (!remote) {
    const names = listRemoteNames(deps.config)
    return { error: `Unknown remote "${req.remoteName}". Configured remotes: ${names.length ? names.join(', ') : '(none)'}` }
  }
  debug(`remote-launch: resolved remote name="${remote.name}" url="${remote.url}" gitRemote="${remote.gitRemote}" sandbox=${remote.sandbox}`)

  const preflight = deps.beforeDiscovery?.()
  if (preflight && 'error' in preflight) return preflight

  // 3. Discovery: find the remote project sharing this repo's OpenCode project
  // identity. OpenCode derives the same id for a given repo on every server
  // (normalized git-origin hash, else the first root commit), so matching on
  // id is location-independent — unlike worktree paths, which differ per
  // machine (e.g. a local checkout vs. a container workspace).
  if (!req.localProjectId) {
    return { error: `Could not resolve the local OpenCode project id for ${req.localDirectory ?? req.remoteName}; cannot match a remote project.` }
  }

  const discoveryClient = (deps.createClient ?? createRemoteForgeClient)({
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
  const client = (deps.createClient ?? createRemoteForgeClient)({
    url: remote.url,
    username: remote.username,
    password: remote.password,
    directory: matched.worktree,
  })

  return { remote, project: { id: matched.id, worktree: matched.worktree }, client }
}

/**
 * Push a local source ref to the shared git remote's forge sync ref. The sync
 * ref is never fetched locally, so the push is forced.
 */
export function pushForgeSyncRef(
  git: GitService,
  args: { cwd: string; gitRemote: string; sourceRef: string; syncRef: string },
): { ok: true } | { ok: false; error: string } {
  const pushResult = git.push(args.cwd, args.gitRemote, `${args.sourceRef}:${args.syncRef}`, true)
  if (!pushResult.ok) {
    return { ok: false, error: pushResult.stderr || '(no stderr)' }
  }
  return { ok: true }
}

/** Delete the forge sync ref on the shared git remote (launch-failure cleanup). */
export function deleteForgeSyncRef(
  git: GitService,
  args: { cwd: string; gitRemote: string; syncRef: string },
): GitResult {
  return git.push(args.cwd, args.gitRemote, `:${args.syncRef}`, false)
}

export async function executeRemoteLoop(
  req: RemoteLoopRequest,
  deps: RemoteLaunchDeps,
): Promise<RemoteLaunchResult> {
  const debug = deps.debug ?? (() => {})
  const git = deps.git ?? defaultGitService

  debug(`remote-launch: start remote="${req.remoteName}" dir="${req.localDirectory}" projectId="${req.localProjectId}" loop="${req.loopName}"`)

  // 1+3+4. Resolve the remote server, discover the matching remote project, and
  // create the scoped client. The git preflight is threaded through as a gate
  // so the error precedence (unknown remote → git checks → discovery) is kept.
  const connected = await connectRemoteProject(
    { remoteName: req.remoteName, localProjectId: req.localProjectId, localDirectory: req.localDirectory },
    {
      config: deps.config,
      createClient: deps.createClient,
      debug,
      beforeDiscovery: () => {
        if (!git.isInsideWorkTree(req.localDirectory)) {
          return { error: `Not a git repository: ${req.localDirectory}` }
        }
        const headResult = git.revParseHead(req.localDirectory)
        if (!headResult.ok) {
          return { error: `Failed to resolve HEAD in ${req.localDirectory}: ${headResult.stderr}` }
        }
        debug(`remote-launch: preflight ok HEAD=${headResult.stdout.trim()}`)
        return undefined
      },
    },
  )
  if ('error' in connected) return connected

  const { remote, project: matched, client: remoteClient } = connected
  const sha = git.revParseHead(req.localDirectory).stdout.trim()

  // Warn about dirty working tree but proceed
  const statusResult = git.statusPorcelain(req.localDirectory)
  if (statusResult.ok && statusResult.stdout.trim().length > 0) {
    deps.onWarning?.(`Uncommitted changes are not included; remote loop starts from HEAD ${sha.substring(0, 7)}`)
  }

  // 5. Reserve a unique loop name (once; launchTuiLoop uses it verbatim below)
  const finalLoopName = await reserveTuiLoopName(remoteClient, null, req.loopName)
  const syncRef = forgeSyncRef(finalLoopName)
  debug(`remote-launch: reserved loop name="${finalLoopName}" syncRef="${syncRef}"`)

  // Resolve the portable configured rules once for both the persisted workspace
  // field and the launch options. Host-specific directory grants stay omitted
  // because they do not exist on the remote machine.
  const remotePermissionOptions = resolveRemoteLoopPermissionOptions(deps.config)

  emitLoopPermissionConfigWarnings(deps.config, deps.config.dataDir || resolveDataDir(), req.localDirectory, {
    logger: { log: debug, error: debug, debug },
    onWarnings: (warnings) => deps.onWarning?.(warnings.join(' ')),
  })

  // 6. Push HEAD to remote ref
  debug(`remote-launch: pushing HEAD:${syncRef} to gitRemote="${remote.gitRemote}" from "${req.localDirectory}"`)
  const pushResult = pushForgeSyncRef(git, {
    cwd: req.localDirectory,
    gitRemote: remote.gitRemote,
    sourceRef: 'HEAD',
    syncRef,
  })
  if (!pushResult.ok) {
    debug(`remote-launch: push FAILED: ${pushResult.error}`)
    return { error: `Failed to push to remote "${remote.name}": ${pushResult.error}` }
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
      // Persist the portable configured rules so every subsequent session of the
      // remote loop (rotations, audits, post-actions) keeps them: those sessions
      // rebuild rulesets from the remote server's own config, which lacks the
      // launching machine's loop.permissions.
      permissionRules: remotePermissionOptions.extraRules,
    },
    forgeLoopOverrides: {
      sandboxEnabled: remote.sandbox,
    },
    permissionOptions: remotePermissionOptions,
    debug,
  })

  if ('error' in launchResult) {
    debug(`remote-launch: launchTuiLoop FAILED: ${launchResult.error}`)
    const cleanup = deleteForgeSyncRef(git, { cwd: req.localDirectory, gitRemote: remote.gitRemote, syncRef })
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
