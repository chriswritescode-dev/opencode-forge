**opencode-forge**

***

<p align="center">
  <img src="_media/logo.webp" alt="OpenCode Forge logo" />
</p>

<h1 align="center">OpenCode Forge</h1>

<p align="center">
  <strong>Loops, plans, sandboxing, and code review for <a href="https://opencode.ai">OpenCode</a> AI agents</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/opencode-forge"><img src="https://img.shields.io/npm/v/opencode-forge" alt="npm" /></a>
  <a href="https://www.npmjs.com/package/opencode-forge"><img src="https://img.shields.io/npm/dm/opencode-forge" alt="npm downloads" /></a>
  <a href="https://github.com/chriswritescode-dev/opencode-forge/blob/main/LICENSE"><img src="https://img.shields.io/github/license/chriswritescode-dev/opencode-forge" alt="License" /></a>
</p>

## Quick Start

```bash
pnpm add opencode-forge
```

Forge supports OpenCode 1.x and OpenCode 2.x from the same package: the server entry exports both the 1.x plugin function and the 2.x `setup` module, and the TUI entry covers both terminal surfaces.

### OpenCode 2.x

Add to your `opencode.json` to enable Forge's server-side hooks, tools, and agents:

```json
{
  "plugins": ["opencode-forge@latest"]
}
```

OpenCode 2 loads the plugin's TUI surface from the same entry, so no separate terminal config is needed. A config-directory install writes a `cli.json` entry instead — see [Plugin-directory install](#plugin-directory-install).

### OpenCode 1.x

Add to your `opencode.json` to enable Forge's server-side hooks, tools, and agents:

```json
{
  "plugin": ["opencode-forge@latest"]
}
```

**For TUI features:** Also add to your `tui.json` to enable the sidebar and execution dialog:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-forge@latest"]
}
```

### Plugin-directory install

Instead of editing the plugin arrays by hand, the installer can wire the plugin into opencode's config directory:

```bash
bunx opencode-forge --link        # re-export shim for the current build
bunx opencode-forge --vendor      # self-contained copy (portable)
```

From a source checkout, use `pnpm run setup --link` or `pnpm run setup --vendor`. Both modes also write the terminal-config entries automatically — the `tui.json` `plugin` entry for OpenCode 1.x and the `cli.json` `plugins` entry for OpenCode 2.x — because neither version auto-loads the TUI plugin from the plugin directory. In a non-interactive shell the flags still require `-y`, `-f`, or `-k`.

| | `--link` | `--vendor` |
| --- | --- | --- |
| Picks up a rebuild | Yes — re-exports the live build | No — re-run after upgrade |
| Portable to another machine | No — absolute path to this checkout | Yes |
| Payload in config dir | Shim only | Full copy (~6.5 MB) |
| Needs re-run after upgrade | No | Yes |

Loops on OpenCode 1.x require version 1.17.8 or newer with `OPENCODE_EXPERIMENTAL_WORKSPACES=true` set in the environment that launches `opencode`:

```bash
export OPENCODE_EXPERIMENTAL_WORKSPACES=true
```

Without it, Forge cannot create loop worktrees, so plan loops, goal loops, TUI Loop launches, and grouped execution fail before their first session. See [Workspace Integration](_media/workspaces.md).

On OpenCode 2.x, loop worktrees use V2's native worktree and location model: no environment variable and no 1.17.8 floor.

## What Forge Adds

Forge ships two plugin entrypoints plus standalone management surfaces:

- **Server plugin** — enabled through OpenCode plugin config in `opencode.json` (`plugin` on 1.x, `plugins` on 2.x). Provides the core hooks, tools, agents, plan storage, loop orchestration, review persistence, and sandbox support.
- **TUI plugin** — the sidebar, execution dialog, and loop restart dialog. On 1.x it is enabled separately in `tui.json`; on 2.x it loads from the server plugin entry (or the `cli.json` `plugins` array).
- **Installer CLI** — installs/upgrades bundled prompts and skills, and installs the plugin itself into opencode's plugin directory (`--link`/`--vendor`/`--unlink`).
- **Dashboard** — an observability interface launchable from the TUI command palette (`Open dashboard`) or via `pnpm dashboard` (source checkouts only).

For a quick tour of the loop itself, see [Loop Flow](#loop-flow) below.

## OpenCode 2.x limitations

The server side — loops, plans, review findings, tools, agents, commands, permissions, sandboxing, and event handling — works on both hosts. These surfaces remain OpenCode 1.x only:

- **Host-session sandbox toggle** — sandboxing a non-loop session from the TUI (`Toggle host sandbox`) has no routing key on V2. Loop sandboxes work on both hosts.
- **Subtask commands** — `review` and `review-plan` run inline in the invoking session on V2 instead of spawning a subtask. Every Forge command runs its turn as the command's agent, then Forge switches the session back to the agent it had before.
- **Retired loop sessions** — the V2 plugin API cannot delete sessions, so rotated coding and audit sessions stay in the session list under their Forge titles.
- **Session transcripts** — V2 exposes a session's history only from its latest compaction onward. Loop usage totals stay exact because Forge reconciles them against the session's cumulative cost and tokens, attributing the pre-compaction share to the session's model.
- **Remote loops and remote dashboard** — launching a loop against a configured remote opencode server, and opening the dashboard for a remote server, are 1.x only.

## Features

- **Plans** — architect authors validated plans directly into SQL storage with `plan-write`/`plan-edit`
- **Execution** — approved-plan launch paths plus direct `/execute-goal` loops in dedicated worktree sessions; plan loops can also target a configured remote opencode server; grouped execution launches features from a PRD as parallel loops
- **Loops** — iterative coding/auditing with an isolated git worktree and optional msb sandbox
- **Review Findings** — persistent, loop-scoped review findings across loop sessions
- **TUI** — sidebar and execution dialog
- **Dashboard** — a repo shell for loops, groups, findings, and plans, with live loop state

## Documentation

- [Agents and Slash Commands](_media/agents-and-commands.md) — the bundled `code`, `architect`, and `auditor` agents, hidden loop agents, and every slash command.
- [Planning and Execution Workflow](_media/workflow.md) — how the architect authors plans, the three execution modes, variants, and grouped execution.
- [Tools Reference](_media/tools.md) — full arguments, section-scoping behavior, restart options, and sandbox shell details.
- [Loop System](_media/loop-system.md) — phases, section lifecycle, review findings, session rotation, stall detection, model configuration, and termination.
- [TUI Plugin](_media/tui.md) — sidebar, palette commands, the execution dialog, model selection, and setup.
- [Dashboard](_media/dashboard.md) — views, hash deep links, and the HTTP API.
- [Workspace Integration](_media/workspaces.md) — OpenCode workspace registration, requirements, and failure behavior.
- [Sandbox](_media/sandbox.md) — host requirements, image building and loading, network access, secrets, bind mounts, and resource defaults.
- [Configuration Reference](_media/configuration.md) — every option in `forge-config.jsonc`, plus the installer and bundled-asset sync.
- [Architecture](_media/architecture.md) — plugin architecture, module layout, hooks, storage, and data flow.
- [Modules](_media/modules.md) — the source tree and each module's public surface.
- [Common Issues](_media/troubleshooting.md) — worktree launch failures and workspace prerequisites.

## Screenshots

Execution flow dialog with mode and model selection:

![Execution Flow](_media/execution.webp)

## Loop Flow

The diagram below shows the overall flow of the Forge loop system — from loop trigger and provisioning through coding/auditing, section advancement, the final audit, and the optional post-action phase. See [Loop System](_media/loop-system.md) for the full lifecycle. Source: [`diagrams/loop-flow.mmd`](_media/loop-flow.mmd).

![Loop Flow](_media/loop-flow.webp)

## Development

```bash
pnpm build      # Compile TypeScript to dist/
pnpm test       # Run tests
pnpm typecheck  # Type check without emitting
```

## License

MIT
