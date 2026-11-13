import { FORGE_PLUGIN_ID } from './constants/plugin'
import { setupForgeTuiV2 } from './tui/v2'

const plugin = { id: FORGE_PLUGIN_ID, setup: setupForgeTuiV2 }

export default plugin
