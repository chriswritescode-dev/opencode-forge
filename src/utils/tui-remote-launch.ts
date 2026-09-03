import { resolveRemoteServer, listRemoteNames, forgeSyncRef, type ResolvedRemoteServer } from './remote-config'
import { defaultGitService, type GitService, type GitResult } from './git-service'
import { createRemoteForgeClient, type RemoteClientOptions } from '../client/sdk-adapter'
import type { ForgeClient } from '../client/port'
import type { PluginConfig } from '../types'
import { resolveRemoteLoopPermissionOptions, type LoopPermissionRulesetOptions } from '../constants/loop'
import { emitLoopPermissionConfigWarnings } from './loop-permission-warnings'
import { resolveDataDir } from './opencode-paths'
import { reserveTuiLoopName, launchTuiLoop, type LaunchInitialPrompt } from './tui-client'
import type { ForgeLoopExtra } from '../services/execution'

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
export async function pushForgeSyncRef(
  git: GitService,
  args: { cwd: string; gitRemote: string; sourceRef: string; syncRef: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const pushResult = await git.pushAsync(args.cwd, args.gitRemote, `${args.sourceRef}:${args.syncRef}`, true)
  if (!pushResult.ok) {
    return { ok: false, error: pushResult.stderr || '(no stderr)' }
  }
  return { ok: true }
}

/** Delete the forge sync ref on the shared git remote (launch-failure cleanup). */
export async function deleteForgeSyncRef(
  git: GitService,
  args: { cwd: string; gitRemote: string; syncRef: string },
): Promise<GitResult> {
  return git.pushAsync(args.cwd, args.gitRemote, `:${args.syncRef}`, false)
}

export interface PrepareRemoteLoopLaunchInput {
  client: ForgeClient
  requestedLoopName: string
  permissionOptions: LoopPermissionRulesetOptions
  config: PluginConfig
  dataDir: string
  localDirectory: string
  debug?: (message: string) => void
  onWarnings?: (messages: string[]) => void
}

export type PrepareRemoteLoopLaunchResult = { loopName: string; syncRef: string }

export interface PushAndLaunchRemoteLoopInput {
  git: GitService
  cwd: string
  remote: ResolvedRemoteServer
  project: { id: string; worktree: string }
  client: ForgeClient
  loopName: string
  syncRef: string
  sourceRef: string
  startRef: string
  title: string
  plan: string
  executionModel?: string
  auditorModel?: string
  executionVariant?: string
  auditorVariant?: string
  permissionOptions: LoopPermissionRulesetOptions
  forgeLoopOverrides?: Omit<Partial<ForgeLoopExtra>, 'sandboxEnabled'>
  initialPrompt?: LaunchInitialPrompt
  pushErrorPrefix?: string
  debug?: (message: string) => void
}

export type PushAndLaunchRemoteLoopResult =
  | { loopName: string; sessionId: string }
  | { error: string; pushed: boolean }

export async function prepareRemoteLoopLaunch(
  input: PrepareRemoteLoopLaunchInput,
): Promise<PrepareRemoteLoopLaunchResult> {
  const debug = input.debug ?? (() => {})
  const loopName = await reserveTuiLoopName(input.client, null, input.requestedLoopName)
  const syncRef = forgeSyncRef(loopName)
  debug(`remote-launch: reserved loop name="${loopName}" syncRef="${syncRef}"`)
  emitLoopPermissionConfigWarnings(input.config, input.config.dataDir || input.dataDir, input.localDirectory, {
    logger: { log: debug, error: debug, debug },
    onWarnings: (warnings) => input.onWarnings?.(warnings),
  })
  return { loopName, syncRef }
}

export async function pushAndLaunchRemoteLoop(
  input: PushAndLaunchRemoteLoopInput,
): Promise<PushAndLaunchRemoteLoopResult> {
  const debug = input.debug ?? (() => {})
  const { remote } = input

  debug(`remote-launch: pushing ${input.sourceRef}:${input.syncRef} to gitRemote="${remote.gitRemote}" from "${input.cwd}"`)
  const pushResult = await pushForgeSyncRef(input.git, {
    cwd: input.cwd,
    gitRemote: remote.gitRemote,
    sourceRef: input.sourceRef,
    syncRef: input.syncRef,
  })
  if (!pushResult.ok) {
    debug(`remote-launch: push FAILED: ${pushResult.error}`)
    const message = input.pushErrorPrefix
      ? `${input.pushErrorPrefix}${pushResult.error}`
      : `Failed to push to remote "${remote.name}": ${pushResult.error}`
    return { error: message, pushed: false }
  }
  debug(`remote-launch: push ok (ref ${input.syncRef} now on ${remote.gitRemote})`)

  let launchResult: Awaited<ReturnType<typeof launchTuiLoop>>
  try {
    launchResult = await launchTuiLoop({
      client: input.client,
      directory: input.project.worktree,
      projectId: input.project.id,
      requestedLoopName: input.loopName,
      loopNameReserved: true,
      connectPollIntervalMs: 500,
      title: input.title,
      plan: input.plan,
      executionModel: input.executionModel,
      auditorModel: input.auditorModel,
      executionVariant: input.executionVariant,
      auditorVariant: input.auditorVariant,
      extraWorkspaceFields: {
        startRef: input.startRef,
        syncRef: input.syncRef,
        gitRemote: remote.gitRemote,
        permissionRules: input.permissionOptions.extraRules,
      },
      forgeLoopOverrides: {
        sandboxEnabled: remote.sandbox,
        ...input.forgeLoopOverrides,
      },
      permissionOptions: input.permissionOptions,
      initialPrompt: input.initialPrompt,
      debug,
    })
  } catch (err) {
    debug(`remote-launch: launchTuiLoop THREW: ${err instanceof Error ? err.message : String(err)}`)
    const cleanup = await deleteForgeSyncRef(input.git, { cwd: input.cwd, gitRemote: remote.gitRemote, syncRef: input.syncRef })
    debug(`remote-launch: sync ref cleanup ${cleanup.ok ? 'ok' : `failed: ${cleanup.stderr.trim() || 'unknown error'}`}`)
    throw err
  }

  if ('error' in launchResult) {
    debug(`remote-launch: launchTuiLoop FAILED: ${launchResult.error}`)
    const cleanup = await deleteForgeSyncRef(input.git, { cwd: input.cwd, gitRemote: remote.gitRemote, syncRef: input.syncRef })
    debug(`remote-launch: sync ref cleanup ${cleanup.ok ? 'ok' : `failed: ${cleanup.stderr.trim() || 'unknown error'}`}`)
    return { error: launchResult.error, pushed: false }
  }

  debug(`remote-launch: launched loop="${launchResult.loopName}" session=${launchResult.sessionId} on "${remote.name}"`)
  return { loopName: launchResult.loopName, sessionId: launchResult.sessionId }
}

export async function executeRemoteLoop(
  req: RemoteLoopRequest,
  deps: RemoteLaunchDeps,
): Promise<RemoteLaunchResult> {
  const debug = deps.debug ?? (() => {})
  const git = deps.git ?? defaultGitService

  debug(`remote-launch: start remote="${req.remoteName}" dir="${req.localDirectory}" projectId="${req.localProjectId}" loop="${req.loopName}"`)

  let sha = ''

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
        sha = headResult.stdout.trim()
        debug(`remote-launch: preflight ok HEAD=${sha}`)
        return undefined
      },
    },
  )
  if ('error' in connected) return connected

  const { remote, project: matched, client: remoteClient } = connected

  // Warn about dirty working tree but proceed
  const statusResult = git.statusPorcelain(req.localDirectory)
  if (statusResult.ok && statusResult.stdout.trim().length > 0) {
    deps.onWarning?.(`Uncommitted changes are not included; remote loop starts from HEAD ${sha.substring(0, 7)}`)
  }

  // Resolve the portable configured rules once for both the persisted workspace
  // field and the launch options. Host-specific directory grants stay omitted
  // because they do not exist on the remote machine.
  const remotePermissionOptions = resolveRemoteLoopPermissionOptions(deps.config)

  const prepared = await prepareRemoteLoopLaunch({
    client: remoteClient,
    requestedLoopName: req.loopName,
    permissionOptions: remotePermissionOptions,
    config: deps.config,
    dataDir: deps.config.dataDir || resolveDataDir(),
    localDirectory: req.localDirectory,
    debug,
    onWarnings: (warnings) => deps.onWarning?.(warnings.join(' ')),
  })

  const launched = await pushAndLaunchRemoteLoop({
    git,
    cwd: req.localDirectory,
    remote,
    project: matched,
    client: remoteClient,
    loopName: prepared.loopName,
    syncRef: prepared.syncRef,
    sourceRef: 'HEAD',
    startRef: sha,
    title: req.title,
    plan: req.plan,
    executionModel: req.executionModel,
    auditorModel: req.auditorModel,
    executionVariant: req.executionVariant,
    auditorVariant: req.auditorVariant,
    permissionOptions: remotePermissionOptions,
    debug,
  })
  if ('error' in launched) return { error: launched.error }

  return {
    loopName: launched.loopName,
    sessionId: launched.sessionId,
    remoteName: remote.name,
  }
}
