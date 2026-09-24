import { z } from 'zod'

/** Per-call context handed to every Forge tool. */
export interface ToolCallContext {
  sessionID: string
  messageID: string
  agent: string
  signal: AbortSignal
}

export interface ToolDefinition<Args extends z.ZodRawShape = z.ZodRawShape> {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolCallContext): Promise<string>
}

export function tool<Args extends z.ZodRawShape>(input: ToolDefinition<Args>): ToolDefinition<Args> {
  return input
}

tool.schema = z
