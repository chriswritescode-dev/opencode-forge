import type { Plugin } from '@opencode/plugin'
import { randomUUID } from 'node:crypto'
import type { ForgeCore } from './forge-core'
import type { SandboxContext } from '../sandbox/context'
import { canonicalizePath } from '../sandbox/path'
import { SHIM_ENV_CONTAINER } from '../sandbox/shell-shim'
import { contentToText, invertRenameTable, V1_TO_V2_TOOL_NAMES } from '../client/v2-adapter'
import { findLastIndex } from '../utils/array'
import { resolveAutoApproveDecision, type PermissionEffectLike } from '../utils/auto-approve-policy'
import { isRecord } from '../utils/is-record'
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
  | 'resolveSandboxForDirectory'
  | 'resolveShellSandbox'
  | 'autoApprovesPermissions'
  | 'autoApproveDenyRules'
  | 'shellShimPath'
>

const SHELL_TOOL = V1_TO_V2_TOOL_NAMES.bash
const SHELL_MARKER_PREFIX = 'forge-sandbox-required-'
const SHELL_MARKER_PATTERN = /^(forge-sandbox-required-[0-9a-f-]{36}) && /

/**
 * Sandboxes awaiting their shell, keyed by the one-off marker the shell tool wrapper prefixed
 * to the command. Process-wide because every plugin instance in the process may run the hook.
 */
const pendingShellSandboxes = processShared('pending-shell-sandboxes.v1', () => new Map<string, SandboxContext>())

/**
 * Wraps the built-in shell tool so a call from a sandboxed session reaches the shell hook
 * tagged with a one-off marker naming its sandbox. The shell hook carries no session
 * identity, so the marker is the only link between the two. An unstripped marker makes the
 * shell fail with "command not found", so a command never silently runs on the host.
 */
async function wrapShellToolForSandbox(ctx: Plugin.Context, core: ForgeHooksV2Core): Promise<void> {
  await ctx.tool.transform((editor) => {
    editor.update(SHELL_TOOL, (tool) => {
      const execute = tool.execute
      tool.execute = async (input, context) => {
        const sandbox = await core.resolveShellSandbox(context.sessionID)
        if (!sandbox) return execute(input, context)
        if (!isRecord(input) || typeof input.command !== 'string') {
          throw new Error('Refusing to run a sandboxed shell call without a command')
        }
        const marker = `${SHELL_MARKER_PREFIX}${randomUUID()}`
        pendingShellSandboxes.set(marker, sandbox)
        try {
          return await execute({ ...input, command: `${marker} && ${input.command}` }, context)
        } finally {
          pendingShellSandboxes.delete(marker)
        }
      }
    })
  })
}

export const AUTO_APPROVE_RULES_UNRESOLVED_MESSAGE =
  'Blocked in auto-approve mode: Forge could not resolve the permission rules for this session. Continue without it and report what was skipped.'

interface AutoApprovePermissionEvent {
  sessionID: string
  agent?: string
  action: string
  resources: ReadonlyArray<string>
  effect: PermissionEffectLike
  message?: string
}

/**
 * Turns an auto-approved `ask` into allow or deny. Explicit OpenCode `ask` rules and the configured
 * deny rules deny with a message; requests no rule matched fall back to allow. An unresolvable agent or
 * session fails closed to deny so a prompt is never shown.
 */
async function resolveAutoApprovedPermission(
  ctx: Plugin.Context,
  core: ForgeHooksV2Core,
  event: AutoApprovePermissionEvent,
): Promise<void> {
  if (event.effect !== 'ask') return
  if (!(await core.autoApprovesPermissions(event.sessionID))) return

  try {
    const session = await ctx.session.get({ sessionID: event.sessionID })
    const agentID = event.agent ?? session.agent
    if (!agentID) throw new Error(`no agent id for session ${event.sessionID}`)
    const agent = await ctx.agent.get({ agentID })
    const rules = [...agent.data.permissions, ...(session.permissions ?? [])]
    const decision = resolveAutoApproveDecision({
      action: event.action,
      resources: event.resources,
      rules,
      denyRules: core.autoApproveDenyRules,
    })
    event.effect = decision.effect
    if (decision.effect === 'deny') event.message = decision.message
  } catch (err) {
    console.error('[forge] auto-approve permission resolution failed', err)
    event.effect = 'deny'
    event.message = AUTO_APPROVE_RULES_UNRESOLVED_MESSAGE
  }
}

export async function registerForgeHooksV2(ctx: Plugin.Context, core: ForgeHooksV2Core): Promise<void> {
  const locationDirectory = ctx.location.directory
  const isProjectLocation = canonicalizePath(locationDirectory) === canonicalizePath(ctx.location.project.canonical)

  await ctx.tool.hook('execute.before', async (event) => {
    const input = { tool: toV1ToolName(event.tool), sessionID: event.sessionID, callID: event.id }
    const output = { args: event.input }
    await core.toolBefore(input, output)
    event.input = output.args
  })

  await ctx.tool.hook('execute.after', async (event) => {
    const input = { tool: toV1ToolName(event.tool), sessionID: event.sessionID, callID: event.id, args: event.input }
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
    await resolveAutoApprovedPermission(ctx, core, event)
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
    const output: { context: string[]; prompt?: string } = { context: [] }
    await core.compacting({ sessionID: event.sessionID }, output)
    if (output.prompt !== undefined) event.system.push({ type: 'text', text: output.prompt })
    for (const text of output.context) event.system.push({ type: 'text', text })
  })
}
