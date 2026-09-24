/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
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
  readonly supportsRemoteTargets: boolean
  colors(): ForgeTuiColors
  toast(input: ForgeToastInput): void
  showDialog(size: ForgeTuiDialogSize, render: () => JSX.Element): void
  clearDialog(): void
  select<Value>(input: ForgeTuiSelectInput<Value>): Promise<Value | undefined>
  prompt(input: ForgeTuiPromptInput): Promise<string | undefined>
  defaultModel(): string
}

export function createV1TuiHost(api: TuiPluginApi): ForgeTuiHost {
  return {
    supportsRemoteTargets: true,
    colors() {
      const theme = api.theme.current
      return {
        text: theme.text,
        textMuted: theme.textMuted,
        error: theme.error,
        selectedText: '#ffffff',
        selectedBackground: theme.borderActive,
      }
    },
    toast(input) {
      api.ui.toast(input)
    },
    showDialog(size, render) {
      api.ui.dialog.setSize(size)
      api.ui.dialog.replace(render)
    },
    clearDialog() {
      api.ui.dialog.clear()
    },
    select<Value>(input: ForgeTuiSelectInput<Value>) {
      return new Promise<Value | undefined>((resolve) => {
        const settle = (value: Value | undefined) => {
          resolve(value)
          api.ui.dialog.clear()
        }
        api.ui.dialog.setSize('large')
        api.ui.dialog.replace(() => (
          <api.ui.DialogSelect
            title={input.title}
            options={input.options}
            current={input.current}
            onSelect={(option) => settle(option.value as Value)}
          />
        ), () => resolve(undefined))
      })
    },
    prompt(input) {
      return new Promise<string | undefined>((resolve) => {
        const settle = (value: string | undefined) => {
          resolve(value)
          api.ui.dialog.clear()
        }
        api.ui.dialog.setSize('large')
        api.ui.dialog.replace(() => (
          <api.ui.DialogPrompt
            title={input.title}
            placeholder={input.placeholder}
            value={input.value ?? ''}
            onConfirm={(value) => settle(value)}
            onCancel={() => settle(undefined)}
          />
        ), () => resolve(undefined))
      })
    },
    defaultModel() {
      return api.state.config?.model ?? ''
    },
  }
}

export function createV2TuiHost(context: Plugin.Context, defaultModel: () => string): ForgeTuiHost {
  const dialog = context.ui.dialog
  return {
    supportsRemoteTargets: false,
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
