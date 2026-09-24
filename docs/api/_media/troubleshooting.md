# Common Issues

See also: [Workspace Integration](workspaces.md), [Sandbox](sandbox.md), [Configuration](configuration.md).

## Worktree execution fails to start

**Most common cause:** the project has no root commit. Worktree loops require a git repository with at least one commit; OpenCode scopes its instance to project `global` when started in a directory without one, and Forge rejects the launch before creating any worktree or session with `No git commit in this project — the loop session would be invisible to this opencode instance. Commit, restart opencode, and retry.`

Symptoms include:

- A plan loop, goal loop, TUI Loop launch, or feature group returns an internal error before its first coding session starts
- Forge logs contain `handleStartLoop: failed to create builtin worktree workspace` or `createBuiltinWorktreeWorkspace: workspace.create returned no workspace id`
- No loop worktree appears in the sidebar

Create an initial commit, restart OpenCode, and retry.

## Workspace prerequisites

Worktree loops require a git repository with at least one commit. If OpenCode started before the initial commit, it resolves the project as `global`; create the commit, restart OpenCode, and retry.
