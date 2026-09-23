import type { Plugin } from '@opencode/plugin'
import type { ForgeCore } from './forge-core'
import { canonicalizePath } from '../sandbox/path'
import { SHIM_ENV_CONTAINER } from '../sandbox/shell-shim'

export const V2_TO_V1_TOOL_NAMES: Record<string, string> = {
  shell: 'bash',
  subagent: 'task',
}

export function toV1ToolName(name: string): string {
  return V2_TO_V1_TOOL_NAMES[name] ?? name
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
  | 'shellShimPath'
>

function contentText(content: string | ReadonlyArray<{ type: string; text?: string }> | undefined): string {
  if (typeof content === 'string') return content
  if (!content) return ''
  const lines: string[] = []
  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string') lines.push(part.text)
  }
  return lines.join('\n')
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
    const text = contentText(event.result.content)
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

  await ctx.shell.hook('create.before', async (event) => {
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
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const message = event.messages[i]
      if (message.role !== 'user') continue
      event.messages[i] = { ...message, content: [...message.content, { type: 'text', text: reminder }] }
      break
    }
  })

  await ctx.session.hook('compaction', async (event) => {
    const output: { context: string[]; prompt?: string } = { context: [] }
    await core.compacting({ sessionID: event.sessionID }, output)
    if (output.prompt !== undefined) event.system.push({ type: 'text', text: output.prompt })
    for (const text of output.context) event.system.push({ type: 'text', text })
  })
}
