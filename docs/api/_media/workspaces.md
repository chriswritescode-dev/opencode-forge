# Workspace Integration

Forge worktree loops run in native OpenCode worktrees and locations: each loop gets its own worktree directory, registered in the project's worktree inventory, and the sidebar lists the project's active loops.

See also: [Loop System](loop-system.md), [Architecture](architecture.md), [Common Issues](troubleshooting.md).

## Requirements

Worktrees and locations are first-class in OpenCode 2.x, so there is no experimental runtime toggle, no environment variable, and no version floor. The only prerequisite is the repository requirement below.

All worktree-based execution paths require a git repository with at least one root commit: `execute-plan` (Loop mode), TUI Loop execution dialog launches, and the launch of a goal chunk all check for the root commit before creating worktrees or sessions. If OpenCode started before the initial commit, it resolves the project as `global`; create the commit, restart OpenCode, and retry.

## How it works

When a worktree loop starts, Forge:

1. Creates the git worktree through its own adapter (`type: "forge"`, `branch: null`, `extra: { loopName, projectDirectory, workspaceCreatedAt }`), including orphaned-branch reuse, worktree config, and sandbox provisioning
2. Persists the worktree metadata in `<worktree>/.forge/workspace.json` — git-excluded and removed with the worktree
3. Publishes the worktree into the V2 project inventory with `ctx.worktree.refresh`
4. Creates the loop session directly at `location.directory = <worktree>`, so the session starts in the worktree location
5. Moves a session into the worktree with `session.move` when a later path still needs it

The adapter's `remove` hook commits in-flight changes (when teardown context allows), stops the sandbox container if any, and removes the worktree directory unless the loop is restartable. Branches are preserved for later restart or merge. Workspaces are listed, reported, and removed from the persisted metadata; a record whose directory is gone is pruned.

A loop name is reserved before any side effects (`src/loop/name-uniqueness.ts`): a new loop start never reuses a name still referenced by a goal chunk (`goal_chunks.loop_name`) or whose `forge/<slug>` branch still exists, taking a `-N` suffix instead. A restart is exempt — it reuses the loop's own name and branch.

Forge deliberately does not register a `worktree.transform` strategy: that would silently become the default for every worktree of the user. The built-in git strategy is also rejected because its `--detach` add bypasses Forge's branch, orphan, config, and sandbox handling.

## Based worktrees and goal planning checkouts

When a loop carries an explicit base ref — as every goal chunk after the first does, stacked on the previous chunk's branch tip — the adapter branches the worktree from that exact commit instead of the project `HEAD` (`git worktree add <dir> -b <branch> <baseRef>`). Both fields travel on the workspace `extra` object: `baseRef` for the base commit, and `branch` for an explicit local branch.

An explicit `branch` (`extra.branch`, for example `pm-61-export`) replaces the generated `forge/<loop>` name and is the branch the loop runs on. With a `baseRef` set, an existing branch is reused only when it equals the base ref or is behind it: the adapter fast-forwards it to `baseRef` and refuses with `Branch <branch> has commits that <baseRef> does not contain` when it carries commits the base ref lacks. Without a `baseRef`, an existing branch is continued as-is, which is the restart path.

`execute-plan` validates the request before creating any workspace or session: `git check-ref-format --branch` for the branch name, the worktree inventory for a branch already checked out elsewhere, and `git rev-parse` for the base ref. Forge never fetches, so a `baseRef` must already resolve locally. Restart and workspace recovery re-create the worktree from the persisted `worktreeBranch` with no base ref, so a loop continues on the same branch at its tip.

A goal's next-chunk planning runs in a plain detached checkout at `<dataDir>/worktrees/.goal-plan-<goalId>-<chunkIndex>` (`git worktree add --detach <dir> <commit>`), not a Forge workspace. The leading dot keeps it from colliding with a loop worktree slug, and a Forge workspace with no matching loop row would be reclaimed by the stale-workspace sweep after its 5-minute grace window. The checkout is removed once the plan is captured or the goal is paused or cancelled.

## Failure behavior

If initial worktree creation fails at startup — API mismatch or a network error — the loop aborts before creating the first loop session. If a worktree disappears after a loop is already running, Forge attempts to re-provision or detach it and continue where possible.

## From the TUI

Loops are launched from the execution dialog (or the `execute-plan` tool); each loop runs in its worktree directory, and the sidebar lists active loops.
