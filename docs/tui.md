# TUI Plugin

The plugin includes a TUI sidebar widget and an execution dialog for launching plans directly in the OpenCode terminal interface. On OpenCode 1.x it is enabled separately from the server plugin in `tui.json` — see [Quick Start](../README.md#quick-start). On OpenCode 2.x the TUI surface loads from the same package entry the server plugin uses, or from the `cli.json` `plugins` array, and provides a smaller surface (see [OpenCode 2.x](#opencode-2x)).

See also: [Dashboard](dashboard.md), [Workflow](workflow.md), [Configuration → TUI](configuration.md#tui).

## OpenCode 2.x

The V2 TUI surface is deliberately minimal:

- the loop sidebar (`tui.sidebar`, `tui.showVersion`), scoped to the current project and refreshed every couple of seconds
- the `Open dashboard` palette command (and `tui.keybinds.dashboard`)
- a warning toast when sandboxing is enabled but the bundled build context is missing

Not available on V2: the execution dialog, plan viewer and editing, loop details/restart, model and variant selection, `Toggle host sandbox`, and `Build sandbox template`. Use the `execute-plan` / `execute-goal` tools, `loop-status` with `restart`, and the [Sandbox](sandbox.md) build commands instead.

## Sidebar

The sidebar shows Forge's connection status and version. Captured plans live on the server in the `plansRepo` SQL store; the TUI keeps no local archive or in-TUI editor.

When sandboxing is configured, the sidebar displays the current session's msb state. The `Toggle host sandbox` palette command, and optional `tui.keybinds.toggleHostSandbox` binding, enable or disable sandbox routing for the current session and its Task subagents. The TUI also follows replacement code and auditor sessions when a loop rotates, but does not follow unrelated subagent sessions.

## Additional Commands

| Command | Description |
|---------|-------------|
| `Toggle host sandbox` | Enable or disable sandbox for the current session |
| `Build sandbox template` | Build, save, and load the sandbox template image |
| `Open dashboard` | Start the Forge dashboard and open it in a browser |

## Execution Dialog

Open the dialog from the command palette as `Execute plan` (default keybind `<leader>f`). The plan is sourced from the stored plan for the current session, so the dialog shows exactly what `execute-plan` would run. Legacy chat capture remains available for backward compatibility when no stored row exists; new plans should always be authored with `plan-write`. If no plan can be resolved, a toast prompts the user and the dialog falls back to a paste-input prompt so a plan can be entered manually. A separate command, `Execute pasted plan`, opens the paste dialog directly.

The dialog provides full control over execution parameters.

### Execution Mode Selection

1. **New session** — Creates a fresh Code session and sends the plan as the initial prompt
2. **Execute here** — Takes over the current session immediately with the plan
3. **Loop** — Prompts the architect to launch an iterative coding/auditing loop via the `execute-plan` tool in an isolated git worktree (msb is used when enabled, configured, and available)

### Model Selection

Two model selectors are available:

**Execution Model** — opens a full model selection dialog with all available providers. Shows recently used models for quick access (derived from your OpenCode sessions, recent Forge loops, OpenCode favorites, and the global default), and defaults to `config.executionModel`, then the most recent Forge loop's selection, then the platform default.

**Auditor Model** — the same model selection interface. Defaults to `config.auditorModel`, then `config.executionModel`, then the most recent Forge loop's auditor or execution model, then the platform default.

Models are sorted with recently used first (last 10, derived from the OpenCode session list, recent Forge loops, OpenCode favorites, and the global default), then connected providers, then configured providers, then the remaining models alphabetically by provider and model name. Recent models are grouped under a `Recent` header, and the rest under their provider name; each entry shows the model name and, as its description, the provider name or a `Reasoning` marker. A **"Use default"** option sits at the top. Recently used models are derived from server-side data each time the dialog opens, so they reflect the latest state across all hosts you have used.

### Persistence

Selections live on the **OpenCode server**, not in a TUI-local cache. Loops launched from the TUI execution dialog stamp the chosen execution and auditor models (and variants) into `workspace.create.extra.forgeLoop`; later dialogs derive defaults and recents from `workspace.list()` plus the session list. This keeps the picker correct when the TUI and OpenCode server run on different hosts.

The dialog tracks only loop-mode executions for recents / last-used defaults; `New session` and `Execute here` modes do not create a workspace, so they do not contribute to recents.

## Setup

When installed from the package, the TUI plugin loads automatically when added to your TUI config. The plugin is auto-detected via the `./tui` export in `package.json`.

On OpenCode 2.x there is no `tui.json`: the TUI surface loads from the plugin configured for the server (`plugins` in `opencode.json`) or from the `cli.json` `plugins` array, so no separate terminal entry is needed. See [Configuration → Plugin-directory install](configuration.md#plugin-directory-install).

Add to your `~/.config/opencode/tui.json` or project-level `tui.json` (OpenCode 1.x):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "opencode-forge"
  ]
}
```

For local development, reference the built TUI file directly:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "/path/to/opencode-forge/dist/tui.js"
  ]
}
```

## Configuration

TUI options are configured in `~/.config/opencode/forge-config.jsonc` under the `tui` key:

```jsonc
{
  "tui": {
    "sidebar": true,
    "showVersion": true
  }
}
```

Set `sidebar` to `false` to disable the widget, Forge client connection, plan-execution commands, and execution dialog. Session-rotation following plus the dashboard, sandbox-template build, and host-sandbox toggle commands remain available.
