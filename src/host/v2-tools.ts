import { tool } from '@opencode-ai/plugin'
import type { ToolContext as V1ToolContext, ToolDefinition } from '@opencode-ai/plugin'
import type { Plugin } from '@opencode/plugin'

const z = tool.schema

type V2ToolEditor = Parameters<Parameters<Plugin.Context['tool']['transform']>[0]>[0]
type V2ToolInfo = Parameters<V2ToolEditor['add']>[0]
type V2ToolContext = Parameters<V2ToolInfo['execute']>[1]

function toJsonSchema(schema: ReturnType<typeof z.object>): Record<string, unknown> {
  const json: Record<string, unknown> = z.toJSONSchema(schema, { io: 'input' })
  delete json.$schema
  return json
}

function formatIssues(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string {
  return issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'root'}: ${issue.message}`)
    .join('\n')
}

function toV1ToolContext(context: V2ToolContext, directory: string): V1ToolContext {
  return {
    sessionID: context.sessionID,
    messageID: context.messageID,
    agent: context.agent,
    directory,
    worktree: directory,
    abort: context.signal,
    metadata: () => {},
    ask: () => Promise.reject(new Error('Tool permission prompts are not available on this host')),
  }
}

export function registerForgeToolsV2(ctx: Plugin.Context, tools: Record<string, ToolDefinition>) {
  const directory = ctx.location.directory
  return ctx.tool.transform((editor) => {
    for (const [name, def] of Object.entries(tools)) {
      const schema = z.object(def.args)
      editor.add({
        name,
        description: def.description,
        input: toJsonSchema(schema),
        options: { codemode: false },
        execute: async (input, context) => {
          const parsed = schema.safeParse(input)
          if (!parsed.success) {
            throw new Error(`Invalid arguments for tool "${name}":\n${formatIssues(parsed.error.issues)}`)
          }
          const result = await def.execute(parsed.data, toV1ToolContext(context, directory))
          return { content: typeof result === 'string' ? result : result.output }
        },
      })
    }
  })
}
