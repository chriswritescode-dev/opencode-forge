import type { Plugin } from '@opencode/plugin'
import { tool, type ToolDefinition } from '../tools/tool'

const z = tool.schema

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

export function registerForgeToolsV2(ctx: Plugin.Context, tools: Record<string, ToolDefinition>) {
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
          const output = await def.execute(parsed.data, {
            sessionID: context.sessionID,
            messageID: context.messageID,
            agent: context.agent,
            signal: context.signal,
          })
          return { content: output }
        },
      })
    }
  })
}
