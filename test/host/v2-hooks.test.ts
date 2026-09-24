import { describe, test, expect, afterEach, vi } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildAgents } from '../../src/agents'
import { buildArchitectReminder, createForgeCore, type ForgeCore } from '../../src/host/forge-core'
import { closeDatabase, createLoopsRepo, initializeDatabase } from '../../src/storage'
import { registerForgeHooksV2, toV1ToolName, type ForgeHooksV2Core } from '../../src/host/v2-hooks'
import { createSessionHooks } from '../../src/hooks/session'
import {
  ensureShellShim,
  SHIM_ENV_CONTAINER,
} from '../../src/sandbox/shell-shim'
import type { SandboxContext } from '../../src/sandbox/context'
import type { LoopRow } from '../../src/storage/repos/loops-repo'
import type { Logger, PluginConfig } from '../../src/types'
import { createFakeForgeClient } from '../helpers/fake-client'
import { createFakeV2Context, type V2HookRegistration } from '../helpers/fake-v2-context'

const PROJECT = '/tmp/forge-hooks-project'
const WORKTREE = '/tmp/forge-hooks-worktree'
const CONTAINER = 'forge-hooks-loop'

const logger = { log() {}, error() {}, debug() {} } as unknown as Logger

function sandboxContext(containerName = CONTAINER): SandboxContext {
  return {
    runtime: {} as SandboxContext['runtime'],
    containerName,
    hostDir: WORKTREE,
    mounts: [],
  }
}

interface StubCoreOptions {
  shellShimPath?: string | null
  resolveSandboxForDirectory?: ForgeHooksV2Core['resolveSandboxForDirectory']
  resolveShellSandbox?: ForgeHooksV2Core['resolveShellSandbox']
  autoApprovesPermissions?: ForgeHooksV2Core['autoApprovesPermissions']
  architectReminderFor?: ForgeHooksV2Core['architectReminderFor']
  toolBefore?: ForgeHooksV2Core['toolBefore']
  toolAfter?: ForgeHooksV2Core['toolAfter']
  chatMessage?: ForgeHooksV2Core['chatMessage']
  systemTransform?: ForgeHooksV2Core['systemTransform']
  compacting?: ForgeHooksV2Core['compacting']
}

interface StubCore {
  core: ForgeHooksV2Core
  before: Array<{ tool: string; args: unknown }>
  after: Array<{ tool: string; output: string }>
  prompts: Array<{ sessionID?: string; messageID?: string; text: string }>
}

function createStubCore(options: StubCoreOptions = {}): StubCore {
  const before: Array<{ tool: string; args: unknown }> = []
  const after: Array<{ tool: string; output: string }> = []
  const prompts: Array<{ sessionID?: string; messageID?: string; text: string }> = []
  const core: ForgeHooksV2Core = {
    toolBefore: async (input, output) => {
      before.push({ tool: input.tool, args: output.args })
      await options.toolBefore?.(input, output)
    },
    toolAfter: async (input, output) => {
      after.push({ tool: input.tool, output: output.output })
      await options.toolAfter?.(input, output)
    },
    chatMessage: async (input, output) => {
      const parts = (output as { parts: Array<{ text: string }> }).parts
      prompts.push({ sessionID: input.sessionID, messageID: input.messageID, text: parts[0]!.text })
      await options.chatMessage?.(input, output)
    },
    systemTransform: async (input, output) => {
      output.system.push('sandbox context note')
      await options.systemTransform?.(input, output)
    },
    compacting: async (input, output) => {
      output.context.push('compaction context')
      await options.compacting?.(input, output)
    },
    architectReminderFor:
      options.architectReminderFor ?? ((agent) => (agent === 'architect' ? buildArchitectReminder() : null)),
    resolveSandboxForDirectory: options.resolveSandboxForDirectory ?? (async () => null),
    resolveShellSandbox: options.resolveShellSandbox ?? (async () => null),
    autoApprovesPermissions: options.autoApprovesPermissions ?? (async () => false),
    shellShimPath: options.shellShimPath ?? null,
  }
  return { core, before, after, prompts }
}

async function invokeHook(
  hooks: V2HookRegistration[],
  domain: string,
  event: string,
  payload: unknown,
): Promise<void> {
  const registration = hooks.find((hook) => hook.domain === domain && hook.event === event)
  expect(registration).toBeDefined()
  await registration!.callback(payload)
}

function shellEvent(overrides: Record<string, unknown> = {}) {
  return {
    command: 'echo hi',
    cwd: WORKTREE,
    timeout: 0,
    shell: '/bin/zsh',
    env: { PATH: '/usr/bin' } as Record<string, string | undefined>,
    ...overrides,
  }
}

describe('toV1ToolName', () => {
  test('maps only the built-in V2 tool names that differ from V1', () => {
    expect(toV1ToolName('shell')).toBe('bash')
    expect(toV1ToolName('subagent')).toBe('task')
    expect(toV1ToolName('read')).toBe('read')
    expect(toV1ToolName('edit')).toBe('edit')
    expect(toV1ToolName('write')).toBe('write')
    expect(toV1ToolName('glob')).toBe('glob')
    expect(toV1ToolName('grep')).toBe('grep')
    expect(toV1ToolName('execute-goal')).toBe('execute-goal')
  })
})

describe('registerForgeHooksV2 permission hook', () => {
  function permissionEvent(effect: 'allow' | 'deny' | 'ask', sessionID = 'ses_sandboxed') {
    return { sessionID, action: 'shell', resources: ['git push'], effect }
  }

  test('approves an ask in a session the core auto-approves', async () => {
    const { ctx, hooks } = createFakeV2Context()
    const { core } = createStubCore({
      shellShimPath: '/tmp/forge-shell',
      autoApprovesPermissions: async (sessionID) => sessionID === 'ses_sandboxed',
    })
    await registerForgeHooksV2(ctx, core)

    const approved = permissionEvent('ask')
    await invokeHook(hooks, 'permission', 'evaluate', approved)
    expect(approved.effect).toBe('allow')

    const other = permissionEvent('ask', 'ses_host')
    await invokeHook(hooks, 'permission', 'evaluate', other)
    expect(other.effect).toBe('ask')
  })

  test('never overrides a deny', async () => {
    const { ctx, hooks } = createFakeV2Context()
    const { core } = createStubCore({ shellShimPath: '/tmp/forge-shell', autoApprovesPermissions: async () => true })
    await registerForgeHooksV2(ctx, core)

    const denied = permissionEvent('deny')
    await invokeHook(hooks, 'permission', 'evaluate', denied)
    expect(denied.effect).toBe('deny')
  })

  test('is not registered without a shell shim', async () => {
    const { ctx, hooks } = createFakeV2Context()
    const { core } = createStubCore({ autoApprovesPermissions: async () => true })
    await registerForgeHooksV2(ctx, core)

    expect(hooks.some((hook) => hook.domain === 'permission' && hook.event === 'evaluate')).toBe(false)
  })
})

describe('registerForgeHooksV2 tool hooks', () => {
  test('execute.before maps shell to bash and leaves the command unchanged', async () => {
    const { ctx, hooks } = createFakeV2Context()
    const { core, before } = createStubCore()
    await registerForgeHooksV2(ctx, core)

    const event = {
      tool: 'shell',
      sessionID: 'ses_1',
      agent: 'code',
      messageID: 'msg_1',
      id: 'call_1',
      input: { command: 'git push origin main', workdir: WORKTREE },
    }
    await invokeHook(hooks, 'tool', 'execute.before', event)

    expect(before).toEqual([{ tool: 'bash', args: { command: 'git push origin main', workdir: WORKTREE } }])
    expect(event.input.command).toBe('git push origin main')
  })

  test('execute.before keeps the V2 glob argument names the sandbox hook reads', async () => {
    const { ctx, hooks } = createFakeV2Context()
    const { core, before } = createStubCore()
    await registerForgeHooksV2(ctx, core)

    const event = {
      tool: 'grep',
      sessionID: 'ses_1',
      agent: 'code',
      messageID: 'msg_1',
      id: 'call_1',
      input: { pattern: 'needle', path: 'src', include: '*.ts' },
    }
    await invokeHook(hooks, 'tool', 'execute.before', event)

    expect(before).toEqual([{ tool: 'grep', args: { pattern: 'needle', path: 'src', include: '*.ts' } }])
  })

  test('execute.after replaces the text content with the hook output', async () => {
    const { ctx, hooks } = createFakeV2Context()
    const { core, after } = createStubCore({
      toolAfter: async (_input, output) => {
        output.output = 'sandbox glob result'
      },
    })
    await registerForgeHooksV2(ctx, core)

    const event = {
      tool: 'glob',
      sessionID: 'ses_1',
      agent: 'code',
      messageID: 'msg_1',
      id: 'call_1',
      input: { pattern: '**/*.ts' },
      status: 'completed' as const,
      result: {
        content: [{ type: 'text' as const, text: 'host glob result' }],
        metadata: { truncated: false },
      },
    }
    await invokeHook(hooks, 'tool', 'execute.after', event)

    expect(after).toEqual([{ tool: 'glob', output: 'host glob result' }])
    expect(event.result.content).toEqual([{ type: 'text', text: 'sandbox glob result' }])
  })

  test('execute.after writes hook metadata back into the result', async () => {
    const { ctx, hooks } = createFakeV2Context()
    const { core } = createStubCore({
      toolAfter: async (_input, output) => {
        output.metadata = { ...output.metadata, handled: true }
      },
    })
    await registerForgeHooksV2(ctx, core)

    const event = {
      tool: 'question',
      sessionID: 'ses_1',
      agent: 'architect',
      messageID: 'msg_1',
      id: 'call_1',
      input: { questions: [] },
      status: 'completed' as const,
      result: {
        content: [{ type: 'text' as const, text: 'answer' }],
        metadata: { answers: [['Loop']] },
      },
    }
    await invokeHook(hooks, 'tool', 'execute.after', event)

    expect(event.result.metadata).toEqual({ answers: [['Loop']], handled: true })
    expect(event.result.content).toEqual([{ type: 'text', text: 'answer' }])
  })

  test('execute.after reports a failed tool with its error message', async () => {
    const { ctx, hooks } = createFakeV2Context()
    const { core, after } = createStubCore()
    await registerForgeHooksV2(ctx, core)

    const event = {
      tool: 'shell',
      sessionID: 'ses_1',
      agent: 'code',
      messageID: 'msg_1',
      id: 'call_1',
      input: { command: 'false' },
      status: 'error' as const,
      error: { message: 'command failed' },
    }
    await invokeHook(hooks, 'tool', 'execute.after', event)

    expect(after).toEqual([{ tool: 'bash', output: 'command failed' }])
  })
})

describe('registerForgeHooksV2 shell hook', () => {
  test('create.before routes a sandboxed loop worktree through the shim', async () => {
    const { ctx, hooks } = createFakeV2Context({
      location: { directory: WORKTREE, project: { directory: PROJECT } },
    })
    const { core } = createStubCore({
      shellShimPath: '/data/forge-shell',
      resolveSandboxForDirectory: async (directory) =>
        directory === WORKTREE ? sandboxContext() : null,
    })
    await registerForgeHooksV2(ctx, core)

    const event = shellEvent()
    await invokeHook(hooks, 'shell', 'create.before', event)

    expect(event.shell).toBe('/data/forge-shell')
    expect(event.env[SHIM_ENV_CONTAINER]).toBe(CONTAINER)
    expect(event.command).toBe('echo hi')
    expect(event.cwd).toBe(WORKTREE)
  })

  test('create.before leaves a non-loop location untouched', async () => {
    const { ctx, hooks } = createFakeV2Context({
      location: { directory: PROJECT, project: { directory: PROJECT } },
    })
    const { core } = createStubCore({ shellShimPath: '/data/forge-shell' })
    await registerForgeHooksV2(ctx, core)

    const event = shellEvent({ cwd: PROJECT })
    await invokeHook(hooks, 'shell', 'create.before', event)

    expect(event.shell).toBe('/bin/zsh')
    expect(event.env[SHIM_ENV_CONTAINER]).toBeUndefined()
  })

  test('create.before resolves a canonical project shell by its cwd', async () => {
    const seen: string[] = []
    const { ctx, hooks } = createFakeV2Context({
      location: { directory: PROJECT, project: { directory: PROJECT } },
    })
    const { core } = createStubCore({
      shellShimPath: '/data/forge-shell',
      resolveSandboxForDirectory: async (directory) => {
        seen.push(directory)
        return directory === WORKTREE ? sandboxContext() : null
      },
    })
    await registerForgeHooksV2(ctx, core)

    const event = shellEvent()
    await invokeHook(hooks, 'shell', 'create.before', event)

    expect(seen).toEqual([WORKTREE])
    expect(event.shell).toBe('/data/forge-shell')
    expect(event.env[SHIM_ENV_CONTAINER]).toBe(CONTAINER)
  })

  test('create.before rejects when the sandbox cannot be restored', async () => {
    const { ctx, hooks } = createFakeV2Context({
      location: { directory: WORKTREE, project: { directory: PROJECT } },
    })
    const { core } = createStubCore({
      shellShimPath: '/data/forge-shell',
      resolveSandboxForDirectory: async () => {
        throw new Error('sandbox restore failed')
      },
    })
    await registerForgeHooksV2(ctx, core)

    const event = shellEvent()
    await expect(invokeHook(hooks, 'shell', 'create.before', event)).rejects.toThrow('sandbox restore failed')
    expect(event.shell).toBe('/bin/zsh')
    expect(event.env[SHIM_ENV_CONTAINER]).toBeUndefined()
  })

  test('create.before leaves the event untouched when no shim is available', async () => {
    const { ctx, hooks } = createFakeV2Context({
      location: { directory: WORKTREE, project: { directory: PROJECT } },
    })
    const { core } = createStubCore({
      shellShimPath: null,
      resolveSandboxForDirectory: async () => sandboxContext(),
    })
    await registerForgeHooksV2(ctx, core)

    const event = shellEvent()
    await invokeHook(hooks, 'shell', 'create.before', event)

    expect(event.shell).toBe('/bin/zsh')
    expect(event.env[SHIM_ENV_CONTAINER]).toBeUndefined()
  })
})

describe('registerForgeHooksV2 shell tool sandbox routing', () => {
  const toolContext = { sessionID: 'ses_host', agent: 'code', messageID: 'msg_1', id: 'call_1' }

  async function setup(resolveShellSandbox: ForgeHooksV2Core['resolveShellSandbox']) {
    const fake = createFakeV2Context({ location: { directory: PROJECT, project: { directory: PROJECT } } })
    const shellEvents: Array<ReturnType<typeof shellEvent>> = []
    fake.builtinTools.shell!.execute = async (input) => {
      const event = shellEvent({ command: (input as { command: string }).command, cwd: PROJECT })
      await invokeHook(fake.hooks, 'shell', 'create.before', event)
      shellEvents.push(event)
      return { content: [] }
    }
    const { core } = createStubCore({ shellShimPath: '/data/forge-shell', resolveShellSandbox })
    await registerForgeHooksV2(fake.ctx, core)
    return { shell: fake.builtinTools.shell!, shellEvents }
  }

  test('routes a sandboxed session shell call through the shim with the original command', async () => {
    const { shell, shellEvents } = await setup(async (sessionID) => (sessionID === 'ses_host' ? sandboxContext('forge-host') : null))

    await shell.execute({ command: 'echo hi' }, toolContext)

    expect(shellEvents).toHaveLength(1)
    expect(shellEvents[0]!.command).toBe('echo hi')
    expect(shellEvents[0]!.shell).toBe('/data/forge-shell')
    expect(shellEvents[0]!.env[SHIM_ENV_CONTAINER]).toBe('forge-host')
  })

  test('leaves a non-sandboxed session shell call untouched', async () => {
    const { shell, shellEvents } = await setup(async () => null)

    await shell.execute({ command: 'echo hi' }, toolContext)

    expect(shellEvents[0]!.command).toBe('echo hi')
    expect(shellEvents[0]!.shell).toBe('/bin/zsh')
    expect(shellEvents[0]!.env[SHIM_ENV_CONTAINER]).toBeUndefined()
  })

  test('routes identical concurrent commands to their own session sandboxes', async () => {
    const fake = createFakeV2Context({ location: { directory: PROJECT, project: { directory: PROJECT } } })
    const commands: string[] = []
    const releases: Array<() => void> = []
    fake.builtinTools.shell!.execute = async (input) => {
      commands.push((input as { command: string }).command)
      await new Promise<void>((resolve) => releases.push(resolve))
      return { content: [] }
    }
    const { core } = createStubCore({
      shellShimPath: '/data/forge-shell',
      resolveShellSandbox: async (sessionID) => sandboxContext(`forge-${sessionID}`),
    })
    await registerForgeHooksV2(fake.ctx, core)

    const first = fake.builtinTools.shell!.execute({ command: 'make test' }, { ...toolContext, sessionID: 'a' })
    const second = fake.builtinTools.shell!.execute({ command: 'make test' }, { ...toolContext, sessionID: 'b' })
    await vi.waitFor(() => expect(commands).toHaveLength(2))

    const events = commands.map((command) => shellEvent({ command, cwd: PROJECT }))
    await invokeHook(fake.hooks, 'shell', 'create.before', events[1])
    await invokeHook(fake.hooks, 'shell', 'create.before', events[0])
    for (const release of releases) release()
    await Promise.all([first, second])

    expect(events.map((event) => event.command)).toEqual(['make test', 'make test'])
    expect(events.map((event) => event.env[SHIM_ENV_CONTAINER])).toEqual(['forge-a', 'forge-b'])
  })

  test('keeps an unmatched marker on the command so the shell fails instead of running on the host', async () => {
    const { ctx, hooks } = createFakeV2Context({ location: { directory: PROJECT, project: { directory: PROJECT } } })
    const { core } = createStubCore({ shellShimPath: '/data/forge-shell' })
    await registerForgeHooksV2(ctx, core)

    const command = 'forge-sandbox-required-00000000-0000-0000-0000-000000000000 && echo hi'
    const event = shellEvent({ command, cwd: PROJECT })
    await invokeHook(hooks, 'shell', 'create.before', event)

    expect(event.command).toBe(command)
    expect(event.shell).toBe('/bin/zsh')
  })

  test('propagates a fail-closed sandbox resolution error from the shell tool', async () => {
    const { shell, shellEvents } = await setup(async () => {
      throw new Error('Host sandbox unavailable for the selected session')
    })

    await expect(shell.execute({ command: 'echo hi' }, toolContext)).rejects.toThrow('Host sandbox unavailable')
    expect(shellEvents).toHaveLength(0)
  })
})

describe('registerForgeHooksV2 session hooks', () => {
  test('prompt forwards the session, message, and text to the core', async () => {
    const { ctx, hooks } = createFakeV2Context()
    const { core, prompts } = createStubCore()
    await registerForgeHooksV2(ctx, core)

    await invokeHook(hooks, 'session', 'prompt', {
      sessionID: 'ses_1',
      messageID: 'msg_1',
      prompt: { text: 'hello' },
      delivery: 'queue',
    })

    expect(prompts).toEqual([{ sessionID: 'ses_1', messageID: 'msg_1', text: 'hello' }])
  })

  test('context appends the sandbox note and the architect reminder', async () => {
    const { ctx, hooks } = createFakeV2Context()
    const { core } = createStubCore()
    await registerForgeHooksV2(ctx, core)

    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'plan this' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ]
    const event = { sessionID: 'ses_1', agent: 'architect', system: [], messages }
    await invokeHook(hooks, 'session', 'context', event)

    expect(event.system).toEqual([{ type: 'text', text: 'sandbox context note' }])
    expect(messages[0]!.content).toEqual([
      { type: 'text', text: 'plan this' },
      { type: 'text', text: buildArchitectReminder() },
    ])
    expect(messages[1]!.content).toEqual([{ type: 'text', text: 'ok' }])
  })

  test('context appends no reminder for a non-architect agent', async () => {
    const { ctx, hooks } = createFakeV2Context()
    const { core } = createStubCore()
    await registerForgeHooksV2(ctx, core)

    const messages = [{ role: 'user', content: [{ type: 'text', text: 'implement this' }] }]
    const event = { sessionID: 'ses_1', agent: 'code', system: [], messages }
    await invokeHook(hooks, 'session', 'context', event)

    expect(messages[0]!.content).toEqual([{ type: 'text', text: 'implement this' }])
  })

  test('compaction appends the context to the system parts', async () => {
    const { ctx, hooks } = createFakeV2Context()
    const { core } = createStubCore()
    await registerForgeHooksV2(ctx, core)

    const event = { sessionID: 'ses_1', system: [], messages: [] }
    await invokeHook(hooks, 'session', 'compaction', event)

    expect(event.system).toEqual([{ type: 'text', text: 'compaction context' }])
  })

  test('compaction keeps context additions alongside the real session hook prompt', async () => {
    const sessionHooks = createSessionHooks('proj_compaction', logger)
    const { ctx, hooks } = createFakeV2Context()
    const { core } = createStubCore({ compacting: sessionHooks.onCompacting })
    await registerForgeHooksV2(ctx, core)

    const event = { sessionID: 'ses_1', system: [] as Array<{ type: string; text: string }>, messages: [] }
    await invokeHook(hooks, 'session', 'compaction', event)

    expect(event.system.map((part) => part.text)).toEqual([
      expect.stringContaining('Your summary will be the ONLY context after compaction'),
      'compaction context',
    ])
  })
})

describe('generated shim', () => {
  test('passes through to the host shell when no container env is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-hooks-shim-'))
    const shim = ensureShellShim(dir, logger)
    expect(shim).not.toBeNull()

    const env = { ...process.env }
    delete env[SHIM_ENV_CONTAINER]
    const result = spawnSync(shim!, ['-c', 'echo ok'], { env, encoding: 'utf-8' })

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('ok')
  })
})

describe('createForgeCore integration', () => {
  const tempDirs: string[] = []
  let core: ForgeCore | null = null
  let coreDataDir: string | null = null

  afterEach(async () => {
    await core?.cleanup()
    core = null
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    tempDirs.push(dir)
    return dir
  }

  async function buildCore(config: PluginConfig = {}): Promise<ForgeCore> {
    const directory = tempDir('forge-hooks-project-')
    const dataDir = join(directory, 'memory')
    coreDataDir = dataDir
    const { client } = createFakeForgeClient()
    core = await createForgeCore(
      { dataDir, ...config },
      { directory, projectId: 'proj_hooks', projectRoot: directory, client, registerWorkspaceAdapter: () => {} },
    )
    return core
  }

  function runningSandboxLoopRow(projectId: string, worktreeDir: string): LoopRow {
    return {
      projectId,
      loopName: 'hooks-loop',
      status: 'running',
      currentSessionId: 'ses_loop',
      worktree: true,
      worktreeDir,
      worktreeBranch: null,
      projectDir: worktreeDir,
      maxIterations: 10,
      iteration: 1,
      auditCount: 0,
      errorCount: 0,
      phase: 'coding',
      executionModel: null,
      auditorModel: null,
      modelFailed: false,
      sandbox: true,
      sandboxContainer: null,
      startedAt: Date.now(),
      completedAt: null,
      terminationReason: null,
      completionSummary: null,
      workspaceId: null,
      hostSessionId: null,
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: 0,
      executionVariant: null,
      auditorVariant: null,
      kind: 'plan',
    }
  }

  test('gates the architect reminder on the agent and the transform config', async () => {
    const built = await buildCore()
    const architect = buildAgents().architect.displayName

    expect(built.architectReminderFor(architect)).toBe(buildArchitectReminder())
    expect(built.architectReminderFor('code')).toBeNull()
    expect(built.architectReminderFor(undefined)).toBeNull()
  })

  test('omits the architect reminder when the transform is disabled', async () => {
    const built = await buildCore({ messagesTransform: { enabled: false } })

    expect(built.architectReminderFor(buildAgents().architect.displayName)).toBeNull()
  })

  test('fails closed for a sandboxed loop worktree and ignores other directories', async () => {
    const built = await buildCore({ sandbox: { enabled: true, image: 'forge-hooks-missing-image:latest' } })
    const worktree = tempDir('forge-hooks-worktree-')

    const db = initializeDatabase(coreDataDir!)
    const loopsRepo = createLoopsRepo(db)
    try {
      loopsRepo.insert(runningSandboxLoopRow('proj_hooks', worktree), { lastAuditResult: null })

      await expect(built.resolveSandboxForDirectory(worktree, { throwOnRestoreError: true })).rejects.toThrow()
      await expect(built.resolveSandboxForDirectory(join(tmpdir(), 'forge-hooks-unrelated'))).resolves.toBeNull()

      loopsRepo.setStatus('proj_hooks', 'hooks-loop', 'completed')
      await expect(built.resolveSandboxForDirectory(worktree, { throwOnRestoreError: true })).resolves.toBeNull()
    } finally {
      closeDatabase(db)
    }
  })

  test('bridges the real core compaction prompt into the V2 system parts', async () => {
    const built = await buildCore()
    const { ctx, hooks } = createFakeV2Context()
    await registerForgeHooksV2(ctx, built)

    const event = {
      sessionID: 'ses_compaction',
      system: [{ type: 'text', text: 'existing system context' }] as Array<{ type: string; text: string }>,
      messages: [],
    }
    await invokeHook(hooks, 'session', 'compaction', event)

    expect(event.system).toHaveLength(2)
    expect(event.system[0]).toEqual({ type: 'text', text: 'existing system context' })
    expect(event.system[1]!.type).toBe('text')
    expect(event.system[1]!.text).toContain('Your summary will be the ONLY context after compaction')
  })

  test('omits the compaction prompt when the core disables customPrompt', async () => {
    const built = await buildCore({ compaction: { customPrompt: false } })
    const { ctx, hooks } = createFakeV2Context()
    await registerForgeHooksV2(ctx, built)

    const event = { sessionID: 'ses_compaction', system: [] as Array<{ type: string; text: string }>, messages: [] }
    await invokeHook(hooks, 'session', 'compaction', event)

    expect(event.system).toEqual([])
  })
})
