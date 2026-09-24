import { VERSION } from '../version'

/** Keyboard shortcut overrides for the Forge TUI commands. */
export type TuiKeybinds = {
  executePlan: string
  dashboard: string
  toggleHostSandbox: string
}

const DEFAULT_KEYBINDS: TuiKeybinds = {
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

export const FORGE_DASHBOARD_COMMAND = {
  id: 'forge.dashboard',
  title: 'Open dashboard',
  description: 'Start the Forge dashboard server and open it in the browser',
  group: 'Forge',
} as const

export function formatForgeTitle(showVersion: boolean): string {
  return showVersion ? `Forge v${VERSION}` : 'Forge'
}

export function resolveTuiOptions(...layers: Array<TuiOptionOverrides | undefined>): TuiOptions {
  let sidebar = true
  let showVersion = true
  let keybinds: TuiKeybinds = { ...DEFAULT_KEYBINDS }
  for (const layer of layers) {
    if (!layer) continue
    if (layer.sidebar !== undefined) sidebar = layer.sidebar
    if (layer.showVersion !== undefined) showVersion = layer.showVersion
    if (layer.keybinds) keybinds = { ...keybinds, ...layer.keybinds }
  }
  return { sidebar, showVersion, keybinds }
}
