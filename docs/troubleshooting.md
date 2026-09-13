# Common Issues

See also: [Workspace Integration](workspaces.md), [Sandbox](sandbox.md), [Configuration](configuration.md).

## Worktree execution fails to start

**Most common cause:** `OPENCODE_EXPERIMENTAL_WORKSPACES=true` was not set in the environment that launched OpenCode. See [Quick Start](../README.md#quick-start) for setup.

Symptoms include:

- A plan loop, goal loop, TUI Loop launch, or feature group returns an internal error before its first coding session starts
- Forge logs contain `createBuiltinWorktreeWorkspace: workspace.create threw`, `workspace.create returned no workspace id`, or `handleStartLoop: failed to create builtin worktree workspace`
- No loop worktree appears in the TUI workspace switcher

The flag must be set before OpenCode starts — setting it inside an already-running session is too late. If OpenCode is launched by a desktop app, service manager, shell alias, terminal profile, or wrapper script, set the variable there and fully restart OpenCode.

## Workspace prerequisites

Worktree loops require a git repository with at least one commit. OpenCode scopes its instance to project `global` when started in a directory without a root commit, and worktree loop sessions created against a `global` project are invisible to the TUI. If you see a "No git commit in this project" error, create an initial commit and restart OpenCode.
