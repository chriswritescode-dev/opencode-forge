# Workspace Integration

Forge worktree loops register as **OpenCode workspaces**, letting you switch between them (and your main project) from the same TUI session without restarting or re-opening anything. On OpenCode 2.x they are created as native worktrees and locations instead.

See also: [Loop System](loop-system.md), [Architecture](architecture.md), [Common Issues](troubleshooting.md).

## Requirements

Workspace integration requires the **experimental workspace runtime** enabled in OpenCode. See [Quick Start](../README.md#quick-start) for the environment variable setup. No forge config option enables or disables this — the toggle is purely on the OpenCode side and must be present before OpenCode starts.

All worktree-based execution paths require a git repository with at least one root commit: `execute-plan` (Loop mode), `execute-goal` (`/execute-goal`), TUI Loop execution dialog launches, grouped execution (`/launch-group`), and group restarts all check for the root commit before creating worktrees, sessions, or group state. If OpenCode started before the initial commit, it resolves the project as `global`; create the commit, restart OpenCode, and retry.

> The `OPENCODE_EXPERIMENTAL_WORKSPACES` flag is not currently documented on opencode.ai. The authoritative source is `packages/core/src/flag/flag.ts` and `packages/opencode/src/effect/runtime-flags.ts` in the OpenCode repo.

## When workspace integration is active

- **OpenCode 1.x, env var set, OpenCode ≥ 1.17.8** → Forge can create the worktree workspace, bind loop sessions to it, and show the loop as a switchable workspace in the TUI.
- **OpenCode 1.x, env var unset or older OpenCode** → `experimental.workspace.create` is unavailable or no-ops, Forge cannot create the loop worktree, and `execute-plan` / `/execute-plan`, `execute-goal`, TUI Loop launches, and `/launch-group` all fail before iteration starts.
- **OpenCode 2.x** → worktrees and locations are first-class, so no environment variable or version floor applies. See [OpenCode 2.x](#opencode-2x) below.

## What it does on OpenCode 1.x

When a worktree loop starts with `OPENCODE_EXPERIMENTAL_WORKSPACES=true`, Forge:

1. Calls `experimental.workspace.create` with `type: "forge"`, `branch: null`, and `extra: { loopName, projectDirectory, workspaceCreatedAt }` to register the workspace through the `forge` adapter
2. The adapter's `create` hook creates the git worktree (reusing an orphaned branch when possible) and, when configured, provisions the msb sandbox
3. Creates a new Code session pointed at the worktree directory
4. Calls `experimental.workspace.warp` to bind the session to that workspace
5. Persists the workspace ID on the loop record (`loops.workspace_id`) so the TUI can route clicks on a loop into the correct workspace

The adapter's `remove` hook commits in-flight changes (when teardown context allows), stops the sandbox container if any, and removes the worktree directory unless the loop is restartable. Branches are preserved for later restart or merge.

## What it does on OpenCode 2.x

Worktrees and locations are first-class, so there is no runtime toggle, no environment variable, and no version floor. When a worktree loop starts, Forge:

1. Creates the git worktree through its own adapter (`type: "forge"`, `branch: null`, `extra: { loopName, projectDirectory, workspaceCreatedAt }`) — the same implementation 1.x uses, including orphaned-branch reuse, worktree config, and sandbox provisioning
2. Publishes the worktree into the V2 project inventory with `ctx.worktree.refresh`
3. Creates the loop session directly at `location.directory = <worktree>`, so the session starts in the worktree location
4. Moves a session into the worktree with `session.move` when a later path still needs it (the 1.x `warp` equivalent)
5. Persists the worktree metadata in `<worktree>/.forge/workspace.json` — git-excluded and removed with the worktree — and lists, reports status, and removes workspaces from it; a record whose directory is gone is pruned

Forge deliberately does not register a `worktree.transform` strategy: that would silently become the default for every worktree of the user. The built-in git strategy is also rejected because its `--detach` add bypasses Forge's branch, pin, orphan, config, and sandbox handling.

## Failure behavior

If initial workspace creation fails at startup — env var unset, OpenCode version too old, network error, API mismatch — the loop aborts before creating the first loop session. On OpenCode 2.x the possible failures are API mismatch and network errors, since neither the env var nor a version floor applies. If a workspace disappears after a loop is already running, Forge attempts to re-provision or detach it and continue where possible.

## From the TUI

- On OpenCode 1.x, loops are launched via the execution dialog (select Loop mode), and active loops appear as switchable workspaces alongside your main project
- On OpenCode 2.x there is no execution dialog; launch loops through the `execute-plan` / `execute-goal` tools, and the sidebar lists active loops
