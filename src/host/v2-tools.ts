import type { Plugin } from '@opencode/plugin'
import { canonicalizePath } from '../sandbox/path'
import { createToolManifest } from '../tools'
import { tool, type ToolDefinition } from '../tools/tool'
import { processShared } from '../utils/process-shared'
import { errorMessage } from '../utils/error-message'

const z = tool.schema

type LocationTools = Map<string, Promise<Record<string, ToolDefinition>>>

function locationToolRegistry(): LocationTools {
  return processShared('v2-location-tools.v2', () => new Map())
}

function notLoadedError(directory: string): Error {
  return new Error(`Forge is not loaded for this session's location (${directory}); retry once it has started.`)
}

function startFailedError(cause: unknown): Error {
  return new Error(`Forge failed to start: ${errorMessage(cause)}`, { cause })
}

async function resolveSessionDirectory(ctx: Plugin.Context, sessionID: string): Promise<string> {
  try {
    const session = await ctx.session.get({ sessionID })
    return session.location.directory
  } catch (err) {
    throw new Error(
      `Forge could not resolve the location of session ${sessionID} (${err instanceof Error ? err.message : String(err)}); retry once it has started.`,
      { cause: err },
    )
  }
}

function toJsonSchema(schema: ReturnType<typeof z.object>) {
  const json = z.toJSONSchema(schema, { io: 'input' })
  delete json.$schema
  return json
}

function formatIssues(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string {
  return issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'root'}: ${issue.message}`)
    .join('\n')
}

export async function registerForgeToolsV2(
  ctx: Plugin.Context,
  tools: Promise<Record<string, ToolDefinition>>,
): Promise<() => void> {
  const location = canonicalizePath(ctx.location.directory)
  const registry = locationToolRegistry()
  const unregister = () => {
    if (registry.get(location) === tools) registry.delete(location)
  }
  const manifest = createToolManifest()

  await ctx.tool.transform((editor) => {
    for (const [name, def] of Object.entries(manifest)) {
      const schema = z.object(def.args)
      editor.add({
        name,
        description: def.description,
        input: toJsonSchema(schema),
        options: { codemode: false },
        execute: async (input, context) => {
          const directory = await resolveSessionDirectory(ctx, context.sessionID)
          const pending = registry.get(canonicalizePath(directory))
          if (!pending) throw notLoadedError(directory)
          const target = await pending.catch((cause: unknown) => {
            throw startFailedError(cause)
          })
          const targetDef = target[name]
          if (!targetDef) {
            throw new Error(`Forge tool "${name}" is not registered for this session's location (${directory}).`)
          }
          const targetSchema = z.object(targetDef.args)
          const parsed = targetSchema.safeParse(input)
          if (!parsed.success) {
            throw new Error(`Invalid arguments for tool "${name}":\n${formatIssues(parsed.error.issues)}`)
          }
          const output = await targetDef.execute(parsed.data, {
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
  registry.set(location, tools)

  return unregister
}
