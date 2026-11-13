import { z } from 'zod'

export interface ToolCallContext {
  sessionID: string
  messageID: string
  agent: string
  signal: AbortSignal
}

export interface ToolDefinition<Args extends Record<string, z.ZodType> = Record<string, z.ZodType>> {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolCallContext): Promise<string>
}

export function tool<Args extends Record<string, z.ZodType>>(input: ToolDefinition<Args>): ToolDefinition<Args> {
  return input
}

tool.schema = z
