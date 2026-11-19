import { homedir } from 'os'
import type { ForgeClient } from '../client/port'
import { resolveSkillsDir } from '../install/paths'
import type { SessionSandboxPreferencesRepo } from '../storage'
import { resolveOpencodeToolOutputDir } from '../storage'
import type { LoopsRepo } from '../storage/repos/loops-repo'
import type { Logger, PluginConfig } from '../types'
import { resolveOpencodeTmpDir } from '../utils/opencode-paths'
import { defaultGitService } from '../utils/git-service'
import { forgeWorktreesRoot } from '../workspace/forge-naming'
import { resolveBundledContainerDir } from '../setup'
import { isSandboxConfigEnabled, resolveSandboxMountConfigs } from './context'
import { readSandboxOverrides } from './loop-settings'
import { createMacosRuntime } from './macos'
import { createLumeClient } from './macos-lume'
import { createMacosSandboxManager } from './macos-manager'
import { planMacosShares } from './macos-shares'
import { createSandboxManager, type SandboxManager, type SandboxManagerConfig } from './manager'
import { createMsbRuntime } from './msb'
import type { SandboxBackendKind, SandboxRuntime } from './runtime'
import { FOLDER_SANDBOX_IDLE_TIMEOUT, isFolderManagerKey, isHostSessionManagerKey } from './session-controller'
import { DEFAULT_SANDBOX_IMAGE, resolveTemplateBuildArgs } from './template'

export function resolveSandboxMode(config: PluginConfig | undefined): SandboxBackendKind {
  return config?.sandbox?.mode === 'macos' ? 'macos' : 'msb'
}

export interface SandboxBackend {
  runtime: SandboxRuntime
  manager: SandboxManager | null
}

export interface CreateSandboxBackendInput {
  config: PluginConfig
  dataDir: string
  projectId: string
  projectRoot: string
  logger: Logger
  forgeClient: ForgeClient
  loopsRepo: Pick<LoopsRepo, 'get'>
  sandboxPreferences: Pick<SessionSandboxPreferencesRepo, 'getDesired'>
  platform?: NodeJS.Platform
  lumeFetch?: typeof globalThis.fetch
}

function createMsbBackend(input: CreateSandboxBackendInput): SandboxBackend {
  const sandboxMountConfigs = resolveSandboxMountConfigs(input.config)
  const sandboxConfig: SandboxManagerConfig = {
    image: input.config.sandbox?.image ?? DEFAULT_SANDBOX_IMAGE,
    projectId: input.projectId,
    toolOutputDir: resolveOpencodeToolOutputDir(),
    tmpDir: resolveOpencodeTmpDir(),
    listSkillPaths: async (dir) => (await input.forgeClient.skill.list({ directory: dir })).map((entry) => entry.path),
    fallbackSkillsDir: resolveSkillsDir(),
    sourceProjectDir: input.projectRoot,
    mountProjectReadonly: input.config.sandbox?.mountProjectReadonly,
    buildContextDir: resolveBundledContainerDir(),
    templateBuildArgs: resolveTemplateBuildArgs(input.config),
    resolveOverrides: (worktreeName) => isHostSessionManagerKey(input.projectId, worktreeName)
      ? input.sandboxPreferences.getDesired(input.projectId)?.overrides
      : readSandboxOverrides(input.loopsRepo.get(input.projectId, worktreeName)?.sandboxSettings),
    resolveIdleTimeout: (worktreeName) => isFolderManagerKey(input.projectId, worktreeName)
      ? FOLDER_SANDBOX_IDLE_TIMEOUT
      : undefined,
  }
  if (sandboxMountConfigs.length > 0) sandboxConfig.customMounts = sandboxMountConfigs
  if (input.config.sandbox?.network) sandboxConfig.network = input.config.sandbox.network
  if (input.config.sandbox?.resources) sandboxConfig.resources = input.config.sandbox.resources
  const runtime = createMsbRuntime(input.logger)
  const manager = createSandboxManager(runtime, sandboxConfig, input.logger, defaultGitService)
  input.logger.log('Sandbox manager initialized')
  return { runtime, manager }
}

function createMacosBackend(input: CreateSandboxBackendInput): SandboxBackend {
  if ((input.platform ?? process.platform) !== 'darwin') {
    throw new Error('sandbox.mode "macos" requires a macOS host; refusing to run worktree-only while the sandbox is enabled')
  }
  if ((input.config.sandbox?.macos?.roots ?? []).length === 0) {
    throw new Error('sandbox.mode "macos" needs at least one entry in sandbox.macos.roots')
  }
  const macosConfig = input.config.sandbox?.macos ?? {}
  const lume = createLumeClient({
    baseUrl: macosConfig.lumeUrl ?? 'http://127.0.0.1:7787',
    fetch: input.lumeFetch,
  })
  const runtime = createMacosRuntime({
    dataDir: input.dataDir,
    config: macosConfig,
    lume,
    logger: input.logger,
  })
  const shares = planMacosShares({
    roots: macosConfig.roots ?? [],
    worktreesDir: forgeWorktreesRoot(input.dataDir),
    tmpDir: resolveOpencodeTmpDir(),
    toolOutputDir: resolveOpencodeToolOutputDir(),
    skillsDir: resolveSkillsDir(),
    extraMounts: resolveSandboxMountConfigs(input.config),
    homeDir: homedir(),
  }, input.logger)
  const manager = createMacosSandboxManager({
    runtime,
    lume,
    dataDir: input.dataDir,
    config: macosConfig,
    shares,
    networkAllow: input.config.sandbox?.network?.allow,
    logger: input.logger,
  })
  input.logger.log('macOS sandbox manager initialized')
  return { runtime, manager }
}

export function createSandboxBackend(input: CreateSandboxBackendInput): SandboxBackend {
  if (!isSandboxConfigEnabled(input.config)) {
    return { runtime: createMsbRuntime(input.logger), manager: null }
  }
  if (resolveSandboxMode(input.config) === 'macos') return createMacosBackend(input)
  return createMsbBackend(input)
}
