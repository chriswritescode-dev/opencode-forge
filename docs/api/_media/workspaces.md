# Workspace Integration

Forge worktree loops run in native OpenCode worktrees and locations: each loop gets its own worktree directory, registered in the project's worktree inventory, and the sidebar lists the project's active loops.

See also: [Loop System](loop-system.md), [Architecture](architecture.md), [Common Issues](troubleshooting.md).

## Requirements

Worktrees and locations are first-class in OpenCode 2.x, so there is no experimental runtime toggle, no environment variable, and no version floor. The only prerequisite is the repository requirement below.

All worktree-based execution paths require a git repository with at least one root commit: `execute-plan` (Loop mode), `execute-goal` (`/execute-goal`), TUI Loop execution dialog launches, grouped execution (`/launch-group`), and group restarts all check for the root commit before creating worktrees, sessions, or group state. If OpenCode started before the initial commit, it resolves the project as `global`; create the commit, restart OpenCode, and retry.

## How it works

When a worktree loop starts, Forge:

1. Creates the git worktree through its own adapter (`type: "forge"`, `branch: null`, `extra: { loopName, projectDirectory, workspaceCreatedAt }`), including orphaned-branch reuse, worktree config, and sandbox provisioning
2. Persists the worktree metadata in `<worktree>/.forge/workspace.json` — git-excluded and removed with the worktree
3. Publishes the worktree into the V2 project inventory with `ctx.worktree.refresh`
4. Creates the loop session directly at `location.directory = <worktree>`, so the session starts in the worktree location
5. Moves a session into the worktree with `session.move` when a later path still needs it

The adapter's `remove` hook commits in-flight changes (when teardown context allows), stops the sandbox container if any, and removes the worktree directory unless the loop is restartable. Branches are preserved for later restart or merge. Workspaces are listed, reported, and removed from the persisted metadata; a record whose directory is gone is pruned.

Forge deliberately does not register a `worktree.transform` strategy: that would silently become the default for every worktree of the user. The built-in git strategy is also rejected because its `--detach` add bypasses Forge's branch, orphan, config, and sandbox handling.

## Failure behavior

If initial worktree creation fails at startup — API mismatch or a network error — the loop aborts before creating the first loop session. If a worktree disappears after a loop is already running, Forge attempts to re-provision or detach it and continue where possible.

## From the TUI

Loops are launched from the execution dialog (or the `execute-plan` / `execute-goal` tools); each loop runs in its worktree directory, and the sidebar lists active loops.
