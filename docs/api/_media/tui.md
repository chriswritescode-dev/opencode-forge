# TUI Plugin

The plugin includes a TUI sidebar widget and an execution dialog for launching plans directly in the OpenCode terminal interface. The TUI surface loads from the same package entry the server plugin uses, or from the `cli.json` `plugins` array (see [Setup](#setup)).

See also: [Dashboard](dashboard.md), [Workflow](workflow.md), [Configuration → TUI](configuration.md#tui).

## Features

The TUI surface provides:

- the [Execution Dialog](#execution-dialog) (`Execute plan`, `tui.keybinds.executePlan`) with plan, model, variant, loop-name, and loop-settings selection. It launches through the server plugin's `executePlan` RPC method, which runs the same execution service as the `execute-plan` tool, and restarts a loop through the server's `loopRestart` RPC
- `Build sandbox template`
- auto-follow of replacement code and auditor sessions when a loop you are viewing rotates. Subagent sessions and sessions outside the loop worktree are not followed.
- the loop sidebar (`tui.sidebar`, `tui.showVersion`), scoped to the current project, listing up to three loops — running loops first, then the most recent finished ones — each as a status-colored bullet with the truncated loop name, status, and `iteration/max`, read through the `loopSidebar` RPC on every `loopsChanged` push. A running loop shows `▸` instead of the bullet; clicking its row expands it to the current phase and how long it has been in it, then the section (`Section n/total`, when the loop has sections) and the loop's total elapsed time. The phase and start times come from the server with the rows; while a loop is expanded the TUI only advances the clocks locally
- the `Open web dashboard` palette command (and `tui.keybinds.dashboard`)
- the `Toggle auto-approve` palette command (and `tui.keybinds.toggleAutoApprove`), which turns per-session auto-approve on or off for the current session and its Task subagents
- a warning toast when sandboxing is enabled but the bundled build context is missing
- Forge's server toasts (loop completion, workspace, sandbox, and permission warnings), delivered from the server plugin over the V2 plugin RPC event bus and shown only for the current project

Everything the TUI reads or changes lives on the OpenCode server, reached through the Forge server RPC port (`FORGE_RPC`): the loop list and sidebar, the session's stored plan, loop restarts, host-sandbox desired/applied state, the server's worktree list, and per-session auto-approve. The TUI does not poll: it fetches once at startup and again when the server pushes `loopsChanged`, `autoApproveChanged`, or `hostSandboxChanged` for its project, when the open session changes, and after the event stream reconnects. The TUI and the server plugin must run the same Forge version: at startup the TUI compares its version with the server's `version` RPC and shows a warning toast on a mismatch or when the server predates the RPC — restart the OpenCode server after upgrading. A restart requested by a TUI older than this release is no longer handled by the server; upgrade that TUI. The TUI holds no Forge database of its own — its only `forge.db` reference is the path handed to the local dashboard launcher — so it works attached to a remote OpenCode server running Forge. The attached server's `sandbox.enabled` decides whether host sandbox is available: when disabled the sidebar hides the indicator and the toggle is refused.

Options come from forge-config `tui`; plugin options set on the `cli.json` entry override them, with keybinds merged per key.

`Execute plan` opens the dialog for the current session's stored plan; with no stored plan the dialog opens with `Plan: none` and a plan is pasted from the dialog's `Plan` row rather than recovered from chat history. With no open session it opens in restart mode instead. The dialog's last-used models come from the project's most recent loop rather than from workspace metadata.

## Sidebar

The sidebar shows the Forge title (with version when `tui.showVersion` is on) and the project's loops. Captured plans live on the server in the `plansRepo` SQL store; the TUI keeps no local archive or in-TUI editor.

When sandboxing is configured, the sidebar displays the current session's msb state as `· MSB enabled/disabled/loading/failed` next to the Forge title. The `Host sandbox` palette command, and optional `tui.keybinds.toggleHostSandbox` binding, open the [host sandbox menu](#host-sandbox-menu), which requests a desired sandbox state for the current session and its Task subagents through the Forge server RPC; the server reconciles the request, acknowledges the applied revision, and routes the session's shell, `glob`, and `grep` calls into the sandbox. The server's `sandbox.enabled` decides availability, so the indicator is hidden and the request is refused when the attached server has sandboxing disabled. While it is on, permission prompts in those sessions are resolved to allow or deny without prompting unless `sandbox.autoApprovePermissions` is `false` (see [Sandbox](sandbox.md#permission-auto-approval)). The TUI also follows replacement code and auditor sessions when a loop rotates, but does not follow unrelated subagent sessions.

When auto-approve is on for the current session, including when it is inherited from a parent session, the sidebar displays `· AUTO` next to the Forge title. The `Toggle auto-approve` palette command, and optional `tui.keybinds.toggleAutoApprove` binding, turn it on or off for the current session and its Task subagents; in a subagent that inherits it, the toggle is refused and names the parent session to toggle instead. The TUI reads and changes the state through the Forge server RPC rather than the local Forge database, so it also works when the TUI is attached to a remote OpenCode server running Forge. It is applied server-side through OpenCode's `permission.evaluate` hook, so it follows the session and its subagents regardless of which TUI is showing it, and it expires after 15 days without session activity (prompts and auto-approved requests). While on, nothing prompts: a request OpenCode would `ask` is resolved to deny or allow. It is denied when the last matching OpenCode rule (agent rules, then session rules; last match wins) is an explicit `ask`, or when it matches an `autoApprove.deny` rule (see [Configuration → Auto-Approve](configuration.md#auto-approve)); otherwise it is allowed. OpenCode `deny` rules still deny, and an unresolvable ruleset denies. It is refused for loop sessions, whose ruleset already allows everything not denied, and enabling it while the host sandbox is off warns that approved commands run directly on the machine. Unlike OpenCode's built-in Auto mode (`session.permissions: "autoaccept"`), which approves requests from every session on the server, this is scoped to the one session and its subagents; keep the built-in setting at `"prompt"`.

## Additional Commands

| Command | Description |
|---------|-------------|
| `Host sandbox` | Turn the sandbox on or off for the current session and set its CPUs, memory, and LAN access |
| `Toggle auto-approve` | Turn per-session auto-approve on or off for the current session |
| `Build sandbox template` | Build, save, and load the sandbox template image |
| `Open web dashboard` | Start the Forge web dashboard and open it in a browser |

### Host Sandbox Menu

The project has one host sandbox, bound to one session at a time. The menu shows:

- **Sandbox** — on, off, starting, or failed for the current session. Pressing enter turns it on (moving it from another session if needed) or off, and sends any changed settings below in the same request, then closes the menu.
- **CPUs**, **Memory** — resource overrides, validated like the loop settings. Defaults come from the server's `sandbox.resources` and are marked `(default)`.
- **LAN access** — whether the sandbox can reach private (LAN) address ranges, which msb blocks by default. The default is the server's `sandbox.network.allowLan`.
- **Reset to defaults** — clears every override.
- **Apply settings** — shown when a setting changed; sends the changes without turning the sandbox on or off. **Discard changes** closes without sending.

Edits are collected until the sandbox is turned on or off, or the settings are applied, so several edits cost one restart. The settings are saved for the project and survive restarts. On a running sandbox, a CPU or memory change restarts it in place: files, installed packages, and the Docker and cache disks are kept, but running processes stop. A LAN access change recreates the sandbox, because msb sets network policy only when a sandbox is created. That loses everything outside the mounted directories, so the menu asks for confirmation first. Disk sizes are not offered because an existing sandbox cannot change them. The agent is told about the new resources, and that the sandbox restarted or was recreated, on its next request (see [Sandbox → Resource Defaults](sandbox.md#resource-defaults)).

## Execution Dialog

Open the dialog from the command palette as `Execute plan` (default keybind `<leader>f`). The plan is sourced from the stored plan for the current session, so the dialog shows exactly what `execute-plan` would run. With no stored plan the dialog opens with `Plan: none`; the `Plan` row pastes a plan, which is also how a plan is entered manually. With no open session the dialog opens in restart mode instead (a toast when nothing is restartable).

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

### Loop Settings

The `Loop settings` row opens a submenu of per-loop overrides that apply to **Loop** mode only; `New session` and `Execute here` ignore them. Defaults come from the attached server's `loopDefaults` RPC, so they are correct even for a remote server, and are marked `(default)`.

- **Max iterations** — empty uses the server's `loop.defaultMaxIterations`; `0` runs until the plan completes.
- **Sandbox** — turn the sandbox off for this loop. It can only be turned off, never on when the server has `sandbox.enabled: false`, and the sandbox rows are hidden entirely when the attached server has no usable sandbox.
- **CPUs**, **Memory**, **Docker disk**, **Cache disk** — per-loop resource overrides, shown only while the sandbox is on. Values are validated (CPUs a positive integer; sizes such as `8g` or `1024m`) and an invalid value is rejected with a toast. They are applied when the loop's sandbox is created.
- **LAN access** — let this loop's sandbox reach private (LAN) address ranges, overriding the server's `sandbox.network.allowLan`. Shown only while the sandbox is on.
- **Reset to defaults** — clears every override.

The overrides are persisted on the loop row and read back whenever its sandbox is (re)created, so a restarted loop keeps its resources and a loop launched with the sandbox off stays off.

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

Set `sidebar` to `false` to disable the widget and the plan-execution commands. Session-rotation following plus the dashboard, sandbox-template build, host-sandbox toggle, and auto-approve toggle commands remain available.
