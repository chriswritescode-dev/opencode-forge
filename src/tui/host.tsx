/** @jsxImportSource @opentui/solid */
import type { Plugin } from '@opencode/plugin/tui'
import type { RGBA } from '@opentui/core'
import type { JSX } from '@opentui/solid'
import type { ForgeToastInput } from '../host/forge-rpc'

export type ForgeTuiDialogSize = 'medium' | 'large' | 'xlarge'

export interface ForgeTuiColors {
  text: RGBA | string
  textMuted: RGBA | string
  error: RGBA | string
  selectedText: RGBA | string
  selectedBackground: RGBA | string
}

export interface ForgeTuiSelectOption<Value> {
  title: string
  value: Value
  description?: string
  category?: string
}

export interface ForgeTuiSelectInput<Value> {
  title: string
  options: ForgeTuiSelectOption<Value>[]
  current?: Value
}

export interface ForgeTuiPromptInput {
  title: string
  placeholder?: string
  value?: string
}

export interface ForgeTuiHost {
  colors(): ForgeTuiColors
  toast(input: ForgeToastInput): void
  showDialog(size: ForgeTuiDialogSize, render: () => JSX.Element): void
  clearDialog(): void
  select<Value>(input: ForgeTuiSelectInput<Value>): Promise<Value | undefined>
  prompt(input: ForgeTuiPromptInput): Promise<string | undefined>
  defaultModel(): string
}

export function createV2TuiHost(context: Plugin.Context, defaultModel: () => string): ForgeTuiHost {
  const dialog = context.ui.dialog
  return {
    colors() {
      const theme = context.theme.surface('dialog')
      return {
        text: theme.text.base,
        textMuted: theme.text.muted,
        error: theme.text.feedback.error.base,
        selectedText: theme.text.action.primary.focused,
        selectedBackground: theme.background.action.primary.focused,
      }
    },
    toast(input) {
      context.ui.toast.show(input)
    },
    showDialog(size, render) {
      dialog.show(render)
      dialog.set({ size })
    },
    clearDialog() {
      dialog.clear()
    },
    select<Value>(input: ForgeTuiSelectInput<Value>) {
      const selected = dialog.select<Value>(input)
      dialog.set({ size: 'large' })
      return selected
    },
    prompt(input) {
      const entered = dialog.prompt(input)
      dialog.set({ size: 'large' })
      return entered
    },
    defaultModel,
  }
}
