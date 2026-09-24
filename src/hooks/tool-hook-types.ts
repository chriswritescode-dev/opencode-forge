export interface ToolBeforeInput {
  tool: string
  sessionID: string
  callID: string
}

export interface ToolBeforeOutput {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool arguments are tool-specific
  args: any
}

export interface ToolAfterInput extends ToolBeforeInput {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool arguments are tool-specific
  args: any
}

export interface ToolAfterOutput {
  title: string
  output: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool metadata is tool-specific
  metadata: any
}

export type ToolBeforeHook = (input: ToolBeforeInput, output: ToolBeforeOutput) => Promise<void>
export type ToolAfterHook = (input: ToolAfterInput, output: ToolAfterOutput) => Promise<void>
