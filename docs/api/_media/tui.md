# TUI Plugin

The plugin includes a TUI sidebar widget and an execution dialog for launching plans directly in the OpenCode terminal interface. The TUI surface loads from the same package entry the server plugin uses, or from the `cli.json` `plugins` array (see [Setup](#setup)).

See also: [Dashboard](dashboard.md), [Workflow](workflow.md), [Configuration → TUI](configuration.md#tui).

## Features

The TUI surface provides:

- the [Execution Dialog](#execution-dialog) (`Execute plan`, `tui.keybinds.executePlan`, and `Execute pasted plan`) with model, variant, and loop-name selection. It launches through the server plugin's `executePlan` RPC method, which runs the same execution service as the `execute-plan` tool.
- `Restart loop`, opening the same execution dialog with restart parameters
- `Build sandbox template`
- auto-follow of replacement code and auditor sessions when a loop you are viewing rotates. Subagent sessions and sessions outside the loop worktree are not followed.
- the loop sidebar (`tui.sidebar`, `tui.showVersion`), scoped to the current project, listing up to three loops — running loops first, then the most recent finished ones — each as a status-colored bullet with the truncated loop name, status, and `iteration/max`, refreshed every couple of seconds
- the `Open dashboard` palette command (and `tui.keybinds.dashboard`)
- a warning toast when sandboxing is enabled but the bundled build context is missing
- Forge's server toasts (loop completion, workspace, sandbox, and permission warnings), delivered from the server plugin over the V2 plugin RPC event bus and shown only for the current project

Options come from forge-config `tui`; plugin options set on the `cli.json` entry override them, with keybinds merged per key.

When no stored plan exists, `Execute plan` opens the paste dialog instead of recovering a plan from chat history. The dialog's last-used models come from the project's most recent loop rather than from workspace metadata.

## Sidebar

The sidebar shows the Forge title (with version when `tui.showVersion` is on) and the project's loops. Captured plans live on the server in the `plansRepo` SQL store; the TUI keeps no local archive or in-TUI editor.

When sandboxing is configured, the sidebar displays the current session's msb state as `· MSB enabled/disabled/loading/failed` next to the Forge title. The `Toggle host sandbox` palette command, and optional `tui.keybinds.toggleHostSandbox` binding, enable or disable sandbox routing for the current session and its Task subagents. While it is on, permission prompts in those sessions are approved automatically unless `sandbox.autoApprovePermissions` is `false` (see [Sandbox](sandbox.md#permission-auto-approval)). The TUI also follows replacement code and auditor sessions when a loop rotates, but does not follow unrelated subagent sessions.

## Additional Commands

| Command | Description |
|---------|-------------|
| `Toggle host sandbox` | Enable or disable sandbox for the current session |
| `Build sandbox template` | Build, save, and load the sandbox template image |
| `Open dashboard` | Start the Forge dashboard and open it in a browser |

## Execution Dialog

Open the dialog from the command palette as `Execute plan` (default keybind `<leader>f`). The plan is sourced from the stored plan for the current session, so the dialog shows exactly what `execute-plan` would run. When no stored plan exists, a toast prompts the user and the dialog falls back to a paste-input prompt so a plan can be entered manually. A separate command, `Execute pasted plan`, opens the paste dialog directly.

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

Selections live on the **OpenCode server**, not in a TUI-local cache. A loop launched from the TUI execution dialog persists the chosen execution and auditor models (and variants) on the loop row; later dialogs derive defaults and recents from the project's loops plus the session list. This keeps the picker correct when the TUI and OpenCode server run on different hosts.

The dialog tracks only loop-mode executions for recents / last-used defaults; `New session` and `Execute here` modes do not create a loop, so they do not contribute to recents.

## Setup

When installed from the package, the TUI surface loads from the plugin entry configured for the server (`plugins` in `opencode.json`) or from the `cli.json` `plugins` array, so no separate terminal entry is needed. See [Configuration → Plugin-directory install](configuration.md#plugin-directory-install).

For local development, point `cli.json`'s `plugins` array at the built `dist` directory:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["/path/to/opencode-forge/dist"]
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

Set `sidebar` to `false` to disable the widget and the plan-execution commands. Session-rotation following plus the dashboard, sandbox-template build, and host-sandbox toggle commands remain available.
