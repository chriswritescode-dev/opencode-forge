# Common Issues

See also: [Workspace Integration](workspaces.md), [Sandbox](sandbox.md), [Configuration](configuration.md).

## Worktree execution fails to start

**Most common cause:** the project has no root commit. Worktree loops require a git repository with at least one commit; OpenCode scopes its instance to project `global` when started in a directory without one. The `guardCommittedProject` precondition rejects the launch with `bad_request` (400) and a "Loop start blocked" error toast before any worktree or session is created:

> No git commit in this project — the loop session would be invisible to this opencode instance. Commit, restart opencode, and retry.

Symptoms include:

- A plan loop, goal loop, TUI Loop launch, or feature group fails immediately with a `bad_request` (400), before its first coding session starts
- A "Loop start blocked" error toast
- No loop worktree appears in the sidebar

Create an initial commit, restart OpenCode, and retry.

**Separate failure — internal workspace creation:** once the git precondition passes, worktree creation can still fail inside the workspace layer. That is a different fault, surfaces as `internal_error` (500), and is logged as `handleStartLoop: failed to create builtin worktree workspace`, sometimes preceded by `createBuiltinWorktreeWorkspace: workspace.create returned no workspace id`. Investigate the worktree/workspace layer rather than the git state.

## Workspace prerequisites

Worktree loops require a git repository with at least one commit. If OpenCode started before the initial commit, it resolves the project as `global`; create the commit, restart OpenCode, and retry.
