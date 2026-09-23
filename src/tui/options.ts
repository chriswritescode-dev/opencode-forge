/** Keyboard shortcut overrides for the Forge TUI commands. */
export type TuiKeybinds = {
  executePlan: string
  dashboard: string
  toggleHostSandbox: string
}

export const DEFAULT_KEYBINDS: TuiKeybinds = {
  executePlan: '<leader>f',
  dashboard: '',
  toggleHostSandbox: '',
}

export type TuiOptions = {
  sidebar: boolean
  showVersion: boolean
  keybinds: TuiKeybinds
}

/** The option fields both the V1 config and the V2 plugin options supply. */
export type TuiOptionOverrides = {
  readonly sidebar?: boolean
  readonly showVersion?: boolean
  readonly keybinds?: Record<string, string>
}

export function resolveTuiOptions(overrides: TuiOptionOverrides | undefined): TuiOptions {
  return {
    sidebar: overrides?.sidebar ?? true,
    showVersion: overrides?.showVersion ?? true,
    keybinds: { ...DEFAULT_KEYBINDS, ...overrides?.keybinds },
  }
}
