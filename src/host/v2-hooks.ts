import type { Plugin } from '@opencode/plugin'
import { randomUUID } from 'node:crypto'
import type { ForgeCore } from './forge-core'
import type { SandboxContext } from '../sandbox/context'
import { canonicalizePath } from '../sandbox/path'
import { SHIM_ENV_CONTAINER } from '../sandbox/shell-shim'
import { contentToText, invertRenameTable, V1_TO_V2_TOOL_NAMES } from '../client/v2-adapter'
import { DEFAULT_MODEL_SUBAGENTS } from '../config'
import { findLastIndex } from '../utils/array'
import { resolveAutoApproveDecision, type PermissionEffectLike } from '../utils/auto-approve-policy'
import { z } from 'zod'
import { processShared } from '../utils/process-shared'

const V2_TO_V1_TOOL_NAME_TABLE = invertRenameTable(V1_TO_V2_TOOL_NAMES)

export function toV1ToolName(name: string): string {
  return V2_TO_V1_TOOL_NAME_TABLE[name] ?? name
}

export type ForgeHooksV2Core = Pick<
  ForgeCore,
  | 'toolBefore'
  | 'toolAfter'
  | 'chatMessage'
  | 'systemTransform'
  | 'compacting'
  | 'architectReminderFor'
  | 'systemAddendumFor'
  | 'resolveSandboxForDirectory'
  | 'resolveShellSandbox'
  | 'autoApprovesPermissions'
  | 'autoApproveDenyRules'
  | 'shellShimPath'
>

const SHELL_TOOL = V1_TO_V2_TOOL_NAMES.bash
const SHELL_MARKER_PREFIX = 'forge-sandbox-required-'
const SHELL_MARKER_PATTERN = /^(forge-sandbox-required-[0-9a-f-]{36}) && /

const pendingShellSandboxes = processShared('pending-shell-sandboxes.v1', () => new Map<string, SandboxContext>())

const shellInputSchema = z.looseObject({ command: z.string() })

const toolArgsSchema = z.looseObject({
  path: z.string().optional(),
  filePath: z.string().optional(),
  include: z.string().optional(),
  pattern: z.string().optional(),
  patchText: z.string().optional(),
})

async function wrapShellToolForSandbox(ctx: Plugin.Context, core: ForgeHooksV2Core): Promise<void> {
  await ctx.tool.transform((editor) => {
    editor.update(SHELL_TOOL, (tool) => {
      const execute = tool.execute
      tool.execute = async (input, context) => {
        const sandbox = await core.resolveShellSandbox(context.sessionID)
        if (!sandbox) return execute(input, context)
        const parsed = shellInputSchema.safeParse(input)
        if (!parsed.success) {
          throw new Error('Refusing to run a sandboxed shell call without a command')
        }
        const marker = `${SHELL_MARKER_PREFIX}${randomUUID()}`
        pendingShellSandboxes.set(marker, sandbox)
        try {
          return await execute({ ...parsed.data, command: `${marker} && ${parsed.data.command}` }, context)
        } finally {
          pendingShellSandboxes.delete(marker)
        }
      }
    })
  })
}

interface AutoApprovePermissionEvent {
  sessionID: string
  action: string
  resources: ReadonlyArray<string>
  effect: PermissionEffectLike
  message?: string
}

async function resolvePermissionAsk(core: ForgeHooksV2Core, event: AutoApprovePermissionEvent): Promise<void> {
  if (event.effect !== 'ask') return
  if (!(await core.autoApprovesPermissions(event.sessionID))) return

  const decision = resolveAutoApproveDecision({
    action: event.action,
    resources: event.resources,
    denyRules: core.autoApproveDenyRules,
  })
  event.effect = decision.effect
  if (decision.effect === 'deny') event.message = decision.message
}

interface ToolExecuteBeforeEvent {
  tool: string
  input: unknown
}

const SUBAGENT_TOOL = 'subagent'

type CompactionOutput = { context: string[]; prompt?: string }

const subagentLaunchInputSchema = z.looseObject({
  agent: z.string().optional(),
  model: z.unknown(),
  sessionID: z.unknown(),
})

type SubagentLaunchInput = z.infer<typeof subagentLaunchInputSchema>

function subagentLaunchAgent(input: SubagentLaunchInput): string | undefined {
  if (input.agent === undefined) return undefined
  if (input.model !== undefined && input.model !== '') return undefined
  if (input.sessionID !== undefined && input.sessionID !== '') return undefined
  return input.agent
}

async function applySubagentDefaultModel(
  ctx: Pick<Plugin.Context, 'model' | 'agent'>,
  event: ToolExecuteBeforeEvent,
): Promise<void> {
  if (event.tool !== SUBAGENT_TOOL) return
  const launchInput = subagentLaunchInputSchema.safeParse(event.input)
  if (!launchInput.success) return
  const agent = subagentLaunchAgent(launchInput.data)
  if (!agent || !DEFAULT_MODEL_SUBAGENTS.includes(agent)) return
  try {
    const resolved = await ctx.agent.get({ agentID: agent })
    if (resolved.data.model) return
    const result = await ctx.model.default()
    if (!result.data) return
    event.input = { ...launchInput.data, model: `${result.data.providerID}/${result.data.id}` }
  } catch (err) {
    console.error('[forge] Failed to resolve the default model for a subagent launch', err)
  }
}

async function shouldInsertSystemAddendum(ctx: Pick<Plugin.Context, 'agent'>, agentID: string): Promise<boolean> {
  try {
    const resolved = await ctx.agent.get({ agentID })
    return !resolved.data.system
  } catch (err) {
    console.error('[forge] Failed to resolve the agent system prompt', err)
    return true
  }
}

export async function registerForgeHooksV2(
  ctx: Plugin.Context,
  core: ForgeHooksV2Core,
): Promise<void> {
  const locationDirectory = ctx.location.directory
  const isProjectLocation = canonicalizePath(locationDirectory) === canonicalizePath(ctx.location.project.canonical)

  await ctx.tool.hook('execute.before', async (event) => {
    await applySubagentDefaultModel(ctx, event)
    const input = { tool: toV1ToolName(event.tool), sessionID: event.sessionID, callID: event.id }
    const parsedArgs = toolArgsSchema.safeParse(event.input)
    const output = { args: parsedArgs.success ? parsedArgs.data : {} }
    await core.toolBefore(input, output)
    if (parsedArgs.success) event.input = output.args
  })

  await ctx.tool.hook('execute.after', async (event) => {
    const input = {
      tool: toV1ToolName(event.tool),
      sessionID: event.sessionID,
      callID: event.id,
      args: toolArgsSchema.safeParse(event.input).data ?? {},
    }
    if (event.status === 'error') {
      await core.toolAfter(input, { title: '', output: event.error.message, metadata: {} })
      return
    }
    const text = contentToText(event.result.content)
    const metadata = event.result.metadata ?? {}
    const output = { title: '', output: text, metadata }
    await core.toolAfter(input, output)
    if (output.output !== text || output.metadata !== metadata) {
      event.result = {
        ...event.result,
        content: [{ type: 'text', text: output.output }],
        metadata: output.metadata,
      }
    }
  })

  if (core.shellShimPath) {
    await wrapShellToolForSandbox(ctx, core)
  }

  await ctx.permission.hook('evaluate', async (event) => {
    await resolvePermissionAsk(core, event)
  })

  await ctx.shell.hook('create.before', async (event) => {
    const marked = SHELL_MARKER_PATTERN.exec(event.command)
    if (marked) {
      const sandbox = pendingShellSandboxes.get(marked[1])
      if (!sandbox || !core.shellShimPath) return
      pendingShellSandboxes.delete(marked[1])
      event.command = event.command.slice(marked[0].length)
      event.shell = core.shellShimPath
      event.env[SHIM_ENV_CONTAINER] = sandbox.containerName
      return
    }
    const directory = isProjectLocation ? event.cwd : locationDirectory
    const sandbox = await core.resolveSandboxForDirectory(directory, { throwOnRestoreError: true })
    if (!sandbox || !core.shellShimPath) return
    event.shell = core.shellShimPath
    event.env[SHIM_ENV_CONTAINER] = sandbox.containerName
  })

  await ctx.session.hook('prompt', async (event) => {
    await core.chatMessage(
      { sessionID: event.sessionID, messageID: event.messageID, agent: undefined },
      { message: {}, parts: [{ type: 'text', text: event.prompt.text }] },
    )
  })

  await ctx.session.hook('context', async (event) => {
    const addendum = core.systemAddendumFor(event.agent)
    if (addendum && (await shouldInsertSystemAddendum(ctx, event.agent))) {
      event.system.splice(1, 0, { type: 'text', text: addendum })
    }

    const system: string[] = []
    await core.systemTransform({ sessionID: event.sessionID }, { system })
    for (const text of system) event.system.push({ type: 'text', text })

    const reminder = core.architectReminderFor(event.agent)
    if (!reminder) return
    const userIndex = findLastIndex(event.messages, (message) => message.role === 'user')
    if (userIndex === -1) return
    const message = event.messages[userIndex]
    event.messages[userIndex] = { ...message, content: [...message.content, { type: 'text', text: reminder }] }
  })

  await ctx.session.hook('compaction', async (event) => {
    const output: CompactionOutput = { context: [] }
    await core.compacting({ sessionID: event.sessionID }, output)
    if (output.prompt !== undefined) event.system.push({ type: 'text', text: output.prompt })
    for (const text of output.context) event.system.push({ type: 'text', text })
  })
}
