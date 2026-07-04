import { basename } from 'path'
import { resolveRemoteServer, listRemoteNames } from './remote-config'
import { defaultGitService, type GitService } from './git-service'
import { createRemoteForgeClient, type RemoteClientOptions } from '../client/sdk-adapter'
import type { ForgeClient } from '../client/port'
import type { PluginConfig } from '../types'
import { reserveTuiLoopName, launchTuiLoop } from './tui-client'

export interface RemoteLoopRequest {
  remoteName: string
  localDirectory: string
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

  // 1. Resolve remote server
  const remote = resolveRemoteServer(deps.config, req.remoteName)
  if (!remote) {
    const names = listRemoteNames(deps.config)
    return { error: `Unknown remote "${req.remoteName}". Configured remotes: ${names.length ? names.join(', ') : '(none)'}` }
  }

  // 2. Preflight git checks
  if (!git.isInsideWorkTree(req.localDirectory)) {
    return { error: `Not a git repository: ${req.localDirectory}` }
  }

  const headResult = git.revParseHead(req.localDirectory)
  if (!headResult.ok) {
    return { error: `Failed to resolve HEAD in ${req.localDirectory}: ${headResult.stderr}` }
  }
  const sha = headResult.stdout.trim()

  // Warn about dirty working tree but proceed
  const statusResult = git.statusPorcelain(req.localDirectory)
  if (statusResult.ok && statusResult.stdout.trim().length > 0) {
    deps.onWarning?.(`Uncommitted changes are not included; remote loop starts from HEAD ${sha.substring(0, 7)}`)
  }

  // 3. Discovery: find remote project matching local directory basename
  const discoveryClient = createClient({
    url: remote.url,
    username: remote.username,
    password: remote.password,
  })

  let projects: Array<{ id: string; worktree: string }>
  try {
    projects = (await discoveryClient.project.list()) as Array<{ id: string; worktree: string }>
  } catch (err) {
    return { error: `Failed to list projects on remote "${remote.name}": ${err instanceof Error ? err.message : String(err)}` }
  }

  const localBasename = basename(req.localDirectory)
  const matches = projects.filter((p) => basename(p.worktree) === localBasename)
  if (matches.length === 0) {
    const candidates = projects.map((p) => basename(p.worktree))
    return { error: `No remote project matches local directory "${localBasename}". Available projects: ${candidates.length ? candidates.join(', ') : '(none)'}` }
  }
  if (matches.length > 1) {
    const ambiguous = matches.map((p) => p.worktree)
    return { error: `Multiple remote projects match local directory "${localBasename}": ${ambiguous.join(', ')}. Remote project worktree must be unique.` }
  }
  const matched = matches[0]

  // 4. Create scoped client for the matched directory
  const remoteClient = createClient({
    url: remote.url,
    username: remote.username,
    password: remote.password,
    directory: matched.worktree,
  })

  // 5. Reserve a unique loop name
  const finalLoopName = await reserveTuiLoopName(remoteClient, null, req.loopName)

  // 6. Push HEAD to remote ref
  const pushRef = `HEAD:refs/forge/${finalLoopName}`
  const pushResult = git.push(req.localDirectory, remote.gitRemote, pushRef, true)
  if (!pushResult.ok) {
    return { error: `Failed to push to remote "${remote.name}": ${pushResult.stderr || '(no stderr)'}` }
  }

  // 7. Launch the remote loop
  const launchResult = await launchTuiLoop({
    client: remoteClient,
    directory: matched.worktree,
    projectId: null,
    requestedLoopName: finalLoopName,
    title: req.title,
    plan: req.plan,
    executionModel: req.executionModel,
    auditorModel: req.auditorModel,
    executionVariant: req.executionVariant,
    auditorVariant: req.auditorVariant,
    sandboxEnabled: remote.sandbox,
    extraWorkspaceFields: {
      startRef: sha,
      syncRef: `refs/forge/${finalLoopName}`,
      gitRemote: remote.gitRemote,
    },
    forgeLoopOverrides: {
      sandboxEnabled: remote.sandbox,
    },
    debug,
  })

  if (!launchResult || 'error' in launchResult) {
    const errMsg = launchResult && 'error' in launchResult ? launchResult.error : 'Failed to launch remote loop'
    return { error: errMsg }
  }

  return {
    loopName: launchResult.loopName,
    sessionId: launchResult.sessionId,
    remoteName: remote.name,
  }
}
