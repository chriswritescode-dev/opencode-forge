# Configuration Reference

Forge reads JSONC configuration from `~/.config/opencode/forge-config.jsonc`, or `$XDG_CONFIG_HOME/opencode/forge-config.jsonc` when `XDG_CONFIG_HOME` is set. On first run, the bundled [`forge-config.jsonc`](../forge-config.jsonc) is copied there if no user config exists.

See also: [Tools](tools.md), [Agents and Slash Commands](agents-and-commands.md), [Sandbox](sandbox.md), [Loop System](loop-system.md).

## Top-Level Options

| Option | Default | Description |
|---|---:|---|
| `dataDir` | `""` | Data directory for `forge.db`, worktrees, and logs. Empty resolves to the platform data dir. |
| `completedLoopTtlMs` | `604800000` | TTL for completed/cancelled/errored/stalled loops before cleanup sweep. |
| `executionModel` | `""` | Fallback model override for plan execution sessions. Format: `provider/model`. |
| `auditorModel` | `""` | Fallback model override for auditor sessions. Format: `provider/model`. |
| `executionVariant` | `""` | Default reasoning/thinking variant for the execution model (e.g. `high`, `max`). |
| `auditorVariant` | `""` | Default reasoning/thinking variant for the auditor model. Independent — does not inherit `executionVariant`. |
| `auditorFallbackModels` | `[]` | Ordered fallback auditor models tried when the current auditor model hits a provider usage/auth limit mid-loop. Entries are either a `provider/model` string or `{ "model": "provider/model", "variant": "high" }` to pin a variant to that fallback; the primary `auditorVariant` is never inherited, so a string entry runs with no variant. Applies only to `auditing`/`final_auditing`. The fallback index resets to `0` after any successful audit (so the preferred model and its variant are retried on the next audit) and on loop restart. Empty/omitted means a limited auditor terminates the loop. |
| `agents` | unset | Per-agent overrides keyed by display name, currently supporting `temperature`. |
| `remotes` | unset | Remote opencode servers available as loop launch targets in the TUI execution dialog. See [Remotes](#remotes). |
| `dashboard` | unset | Dashboard HTTP server bind host and port. Defaults to loopback only. See [Dashboard](#dashboard). |

## Logging

| Option | Default | Description |
|---|---:|---|
| `logging.enabled` | `false` | Enable file logging. |
| `logging.debug` | `false` | Enable debug logging. |
| `logging.file` | `""` | Log path. Omit or set to `null` for the default log path. An empty string is passed through and can fail silently. |

Default log path: `~/.local/share/opencode/forge/logs/forge.log` or `$XDG_DATA_HOME/opencode/forge/logs/forge.log`.

## Compaction

| Option | Default | Description |
|---|---:|---|
| `compaction.customPrompt` | `true` | Use Forge's custom compaction prompt. |
| `compaction.maxContextTokens` | `0` | Maximum context tokens for compaction. `0` means unlimited. |

## Messages Transform

| Option | Default | Description |
|---|---:|---|
| `messagesTransform.enabled` | `true` | Enable message transformation for Architect read-only enforcement and marked-plan instructions. |
| `messagesTransform.debug` | `false` | Enable debug logging for the transform. |

## Loop

| Option | Default | Description |
|---|---:|---|
| `loop.enabled` | `true` | Enable iterative loops. |
| `loop.defaultMaxIterations` | `15` | Default max iterations. `0` means unlimited. |
| `loop.cleanupWorktree` | `false` | Auto-remove worktree on cancel. |
| `loop.stallTimeoutMs` | `60000` | Stall watchdog timeout in milliseconds. |
| `loop.maxConsecutiveStalls` | `5` | Consecutive stalls before terminating with `stall_timeout`. `0` disables stall termination. |
| `loop.allowExternalDirectories` | unset | Absolute host directories that loop, audit, and post-action sessions may read despite worktree isolation. |
| `loop.worktreeOpencodeConfig` | unset | Inline [opencode config](https://opencode.ai/config.json) written as `opencode.jsonc` into each freshly created loop worktree. Enables per-loop customization (MCP servers, model overrides, etc.). Skip-if-exists — never overwrites a committed `opencode.json`/`opencode.jsonc`. The written file is git-excluded to keep it out of loop commits. |

### Worktree Logging

| Option | Default | Description |
|---|---:|---|
| `loop.worktreeLogging.enabled` | `false` | Enable worktree loop completion logging. |
| `loop.worktreeLogging.directory` | `""` | Completion log directory. Empty resolves to the platform data dir. |

### Post-Action

`loop.postAction` configures an optional post-completion action phase. It runs inside the worktree after a clean final audit and before teardown.

The phase is enabled only when `enabled === true` and at least one of `skill` or `prompt` is configured.

| Option | Default | Description |
|---|---:|---|
| `loop.postAction.enabled` | `false` | Enable the post-action phase. |
| `loop.postAction.skill` | unset | Skill name to load with the Skill tool. |
| `loop.postAction.prompt` | unset | Extra instruction text, or standalone prompt when no skill is set. |
| `loop.postAction.model` | unset | Optional model override. Defaults to the auditor model chain. |

Example:

```jsonc
{
  "loop": {
    "postAction": {
      "enabled": true,
      "skill": "pr-review",
      "prompt": "Auto-defer anything needing clarification; do not use the question tool.",
      "model": "provider/model"
    }
  }
}
```

### Worktree Opencode Config

`loop.worktreeOpencodeConfig` writes an inline opencode config file (`opencode.jsonc`) at the root of each freshly created loop worktree. This enables per-loop customization — primarily MCP servers — without modifying the host config or polluting loop commits.

The config is written only when:
- The worktree has no existing `opencode.json` or `opencode.jsonc` (committed configs are never overwritten)
- The value is a non-empty object

The written file is added to the worktree's git exclude so it never appears in `git status` or loop commits.

Notes:
- The written file is ephemeral. Forge deletes its own `opencode.jsonc` before any teardown commit (and the whole worktree is removed on completion), so it can never land in loop history — even if the git-exclude write failed. A repository-tracked `opencode.jsonc` is never deleted (forge did not write it). Because the file is removed at teardown, a restarted loop is rewritten from the current `loop.worktreeOpencodeConfig`, so edits take effect on the next run.
- MCP servers declared here run as **host** processes from the worktree directory. When [Sandbox](sandbox.md) is enabled, only `bash`/`glob`/`grep` execute inside the sandbox; the MCP commands themselves are not sandbox-isolated. To run an MCP server *inside* the loop's sandbox, use the placeholder below with an `sbx exec -i` command.
- The string `{{FORGE_SANDBOX_CONTAINER}}` in any config value is replaced with the loop's sandbox container name (`forge-<loop>`) when the file is written. For loops without a sandbox, `mcp` entries referencing the placeholder are dropped instead, so the same config works with and without the sandbox.

## Group Launch

`groupLaunch` configures parallel feature orchestration (see the [`launch-group`](tools.md#group-tools) tool).

| Option | Default | Description |
|---|---:|---|
| `groupLaunch.maxConcurrentLoops` | `3` | Maximum number of loops a group runs concurrently. Clamped to a minimum of `1`. Used as the default when `launch-group` is called without a per-group `maxConcurrentLoops`; an explicit per-group value overrides it. |

## TUI

| Option | Default | Description |
|---|---:|---|
| `tui.sidebar` | `true` | Show the Forge sidebar widget. |
| `tui.showVersion` | `true` | Show the Forge version in the sidebar title. |
| `tui.keybinds.executePlan` | `"<leader>f"` | Open the execution dialog. Avoid `<leader>e`, which conflicts with opencode's built-in `editor_open`. |
| `tui.keybinds.dashboard` | `""` | Optional keybind for opening the dashboard. Empty registers the command without a default binding. |

## Dashboard

`dashboard` controls the bind address of the read-only observability dashboard, served by both `pnpm dashboard` and the TUI `Open dashboard` command. The default binds loopback only, so the dashboard is reachable exclusively from the machine running Forge.

| Option | Default | Description |
|---|---:|---|
| `dashboard.host` | `"localhost"` | Bind hostname or IP. Use `"0.0.0.0"` to listen on all interfaces so the dashboard is reachable over a LAN or VPN. Blank falls back to the default. |
| `dashboard.port` | `4747` | Base bind port. Consecutive ports (`port`..`port+9`) are tried when the port is busy. `0` lets the OS pick an ephemeral port. Invalid values fall back to the default and are reported. |

> **The dashboard has no authentication.** Binding a non-loopback address exposes every loop plan, goal, audit result, finding, and session cost to anyone who can reach the port. Restrict access at the network layer with a firewall, a private LAN, or a VPN. Forge prints a warning whenever the bind is not loopback.

A value that is present but unusable — a quoted `"port": "4747"`, a fractional or out-of-range port, a non-string host — is never dropped silently: Forge falls back to the next candidate and reports which value it ignored on stderr (`pnpm dashboard`) or in the toast (TUI).

When bound to a wildcard host (`0.0.0.0` / `::`), the advertised URL uses this machine's best-guess LAN IPv4 address so it can be typed on another device; the TUI still opens `http://localhost:<port>` locally and shows both URLs. Candidates are ranked to prefer a physical interface with a private address over VPN tunnels and container bridges, and the choice is deterministic across launches. That ranking is a heuristic — set `dashboard.host` to an explicit address when a machine has several and the wrong one is advertised.

`dashboard.host` and `dashboard.port` are the supported way to change the bind, and the only one available to an installed package.

For a **source checkout**, `pnpm dashboard` additionally accepts `--host` and `--port`, which override the config values (precedence: CLI flag > `dashboard.*` config > default):

```bash
pnpm dashboard --host 0.0.0.0 --port 4747
```

It also accepts `--db` to point at a specific database file. That has no `dashboard.*` counterpart; its precedence is `--db` > `FORGE_DB` environment variable > `<dataDir>/forge.db`.

These flags are unavailable to users who installed the package, because `scripts/dashboard.ts` runs from the repository sources rather than the published bundle.

Example:

```jsonc
{
  "dashboard": {
    "host": "0.0.0.0",
    "port": 4747
  }
}
```

## Remotes

`remotes` registers remote opencode servers as loop launch targets. When at least one remote is configured, the TUI execution dialog shows a `Target` picker; selecting a remote launches the loop on that server instead of locally. Remote targets support **Loop mode only** — `New session` and `Execute here` remain local.

| Option | Default | Description |
|---|---:|---|
| `remotes[].name` | required | Unique display name shown in the TUI target picker. |
| `remotes[].url` | required | Base URL of the remote opencode server, e.g. `http://192.168.1.20:4096`. |
| `remotes[].password` | unset | Basic-auth password (`OPENCODE_SERVER_PASSWORD` on the remote). Omit when the remote runs without auth. Stored in plaintext in this config file. |
| `remotes[].username` | `"opencode"` | Basic-auth username (`OPENCODE_SERVER_USERNAME` default). |
| `remotes[].gitRemote` | `"origin"` | Git remote name, configured on **both** machines' clones, used for code sync. |
| `remotes[].sandbox` | `true` | Whether the remote loop runs sandboxed. Must mirror the remote server's actual `sandbox.enabled`/sbx capability — see below. |

Example:

```jsonc
{
  "remotes": [
    {
      "name": "my-server",
      "url": "http://192.168.1.20:4096",
      "password": "",
      "username": "opencode",
      "gitRemote": "origin",
      "sandbox": true
    }
  ]
}
```

### How remote launch works

1. The local machine resolves the remote project by matching the local repo's **OpenCode project id** (normalized git-origin hash, else the first root commit) against the remote server's project ids. This is location-independent, so the local checkout path and the remote worktree path (e.g. a container workspace) do not need to match.
2. Local `HEAD` is force-pushed to `refs/forge/<loopName>` on the shared `gitRemote` (uncommitted changes are not included; a warning is shown).
3. The remote server creates the loop worktree pinned to that exact SHA, fetching the sync ref when the commit is not yet in its clone.
4. On final loop teardown, the remote deletes the sync ref from the shared git remote (restart-preserving teardowns keep it). If a loop is deleted outside normal teardown, remove leftovers manually with `git push <gitRemote> --delete refs/forge/<loopName>`.

### Caveats

- **Version skew**: the remote server must run a forge version with SHA-pin support (`startRef`/`syncRef` handling — the same release that introduced `remotes`, or newer). An older remote silently ignores the pin and runs the loop from its clone's current `HEAD` with no error on either side.
- **Sandbox mirroring**: `remotes[].sandbox` is a local assertion about the remote's capability. The launch bakes the session's shell permission ruleset from it; if it does not match the remote's real sandbox state, loop shell commands can be denied.
- **Observability**: remote loops run entirely on the remote server. They do not appear in the local sidebar, `loop-status`, or dashboard. Results land on the `forge/<loopName>` branch in the remote machine's clone; fetch or push that branch from the remote to retrieve them.

## Sandbox

See [Sandbox](sandbox.md) for detailed behavior and security notes.

| Option | Default | Description |
|---|---:|---|
| `sandbox.enabled` | `true` | Enable sandboxed execution when the `sbx` daemon is available. |
| `sandbox.mode` | `"sbx"` | Sandbox mode. `sbx` is currently the only supported mode. |
| `sandbox.image` | `"oc-forge-sandbox:latest"` | sbx template tag used for sandboxed execution. |
| `sandbox.resources.memory` | `"8g"` | Sandbox memory limit (`sbx create --memory`). |
| `sandbox.resources.cpus` | `"4"` | CPU count (`sbx create --cpus`; integer-only). |
| `sandbox.mountProjectReadonly` | `true` | Mount the source project read-only at its identical host path. |
| `sandbox.mounts` | `[]` | Additional host directories to mount at their identical host path. |
| `sandbox.network.allow` | `[]` | Hosts the sandbox may reach (deny-by-default proxy). |
| `sandbox.network.env` | `[]` | Host environment variables to pass into each sandbox command via the env file. |

## Bundled Assets & Installer

Forge ships editable assets that are installed into your config dir:

| Asset | Installed to | Manifest |
|---|---|---|
| Agent & command prompts | `~/.config/opencode/forge/prompts/` | `~/.config/opencode/forge/manifests/prompts.json` |
| Skills | `~/.config/opencode/skills/` | `~/.config/opencode/forge/manifests/skills.json` |
| Config | `~/.config/opencode/forge-config.jsonc` | — |

### Automatic startup sync

On every plugin load, Forge silently syncs bundled prompts and skills. The sync is non-destructive and tracks provenance by content hash in the manifests:

- **New file** → installed.
- **Unedited file, bundle changed** → refreshed to the new bundled version.
- **File you edited** → preserved; never overwritten.
- Files are **never deleted** by the startup sync.

Because edits are detected by comparing the file hash against the recorded manifest hash, you should never hand-edit a manifest. Setting a manifest hash to match a file you changed makes the sync think the file is pristine and overwrite it on the next bundle update. Edit the asset; leave the manifest alone. To restore a bundled default, delete the file and restart.

### Interactive installer

Run the bundled installer for deliberate (re)installation, conflict resolution, and cleanup of orphaned files from older layouts:

```bash
bunx opencode-forge        # or: npx opencode-forge
pnpm setup                 # from a checkout
```

| Flag | Behavior |
|---|---|
| `-f`, `--force` | Overwrite all conflicting files and delete all orphans. |
| `-k`, `--keep` | Keep all local versions; never delete anything. |
| `-y`, `--yes` | Non-interactive: keep edited files, prune orphans. |
| `-n`, `--dry-run` | Report the plan without writing anything. |
| `--no-prune` | Only report orphaned files; never delete them. |

Without a flag the installer is interactive: for each conflicting file it offers overwrite / keep / diff, and for each orphan it offers delete / keep. When you choose **keep** on a conflict, the manifest is updated so future startup syncs continue to preserve your version.
