# Common Issues

See also: [Workspace Integration](workspaces.md), [Sandbox](sandbox.md), [Configuration](configuration.md).

## Worktree execution fails to start

**Most common cause:** the project has no root commit. Worktree loops require a git repository with at least one commit; OpenCode scopes its instance to project `global` when started in a directory without one. The `guardCommittedProject` precondition rejects the launch with `bad_request` (400) and a "Loop start blocked" error toast before any worktree or session is created:

> No git commit in this project — the loop session would be invisible to this opencode instance. Commit, restart opencode, and retry.

Symptoms include:

- A plan loop or TUI Loop launch fails immediately with a `bad_request` (400), before its first coding session starts
- A "Loop start blocked" error toast
- No loop worktree appears in the sidebar

Create an initial commit, restart OpenCode, and retry.

**Separate failure — internal workspace creation:** once the git precondition passes, worktree creation can still fail inside the workspace layer. That is a different fault, surfaces as `internal_error` (500), and is logged as `handleStartLoop: failed to create builtin worktree workspace`, sometimes preceded by `createBuiltinWorktreeWorkspace: workspace.create returned no workspace id`. Investigate the worktree/workspace layer rather than the git state.

## Workspace prerequisites

Worktree loops require a git repository with at least one commit. If OpenCode started before the initial commit, it resolves the project as `global`; create the commit, restart OpenCode, and retry.

## A goal is paused or stuck planning

A goal pauses instead of retrying when a chunk loop ends not-completed, when the chunk planner fails to produce a plan, or when the chunk cap is reached; a goal is also left paused if the plugin restarts while a chunk was planning. `goal-status <goalId>` shows the reason and each chunk's stage.

Recover with `goal-status restart`:

- `goal-status goalId=<goalId> restart=true` re-plans an interrupted planning chunk, or catches a completed chunk loop whose `settled` notification never advanced the goal.
- Add `force=true` when the chunk is still marked as planning in flight and you want to discard it (for example after the planner session was lost).
- Add `maxChunks=<n>` when the goal paused at its chunk cap.
- A paused goal whose chunk loop ended cancelled, errored, or stalled resumes automatically once you restart that loop (`loop-status name=<loop> restart=true`) and it completes.

If a goal is paused with "Chunk N has no branch" or "Could not resolve branch", the previous chunk's branch is gone or unreadable; restore it and restart the goal. `goal-cancel goalId=<goalId>` (optionally `cancelRunningLoops=true`) abandons the goal.
