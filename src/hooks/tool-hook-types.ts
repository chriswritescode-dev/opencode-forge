export interface ToolBeforeInput {
  tool: string
  sessionID: string
  callID: string
}

export type ToolArgs = {
  readonly path?: string
  readonly filePath?: string
  readonly include?: string
  readonly pattern?: string
  readonly patchText?: string
}

export type ToolMetadata = {
  readonly answers?: string[][]
  readonly forgePlanApprovalHandled?: boolean
  readonly forgePlanApprovalDuplicate?: boolean
}

export interface ToolBeforeOutput {
  readonly args: ToolArgs
}

export interface ToolAfterInput extends ToolBeforeInput {
  args: ToolArgs
}

export interface ToolAfterOutput {
  title: string
  output: string
  metadata: ToolMetadata
}

export type ToolBeforeHook = (input: ToolBeforeInput, output: ToolBeforeOutput) => Promise<void>
export type ToolAfterHook = (input: ToolAfterInput, output: ToolAfterOutput) => Promise<void>
