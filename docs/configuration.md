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
| `agents` | unset | Per-agent overrides keyed by display name, currently supporting `temperature`. |

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

## TUI

| Option | Default | Description |
|---|---:|---|
| `tui.sidebar` | `true` | Show the Forge sidebar widget. |
| `tui.showVersion` | `true` | Show the Forge version in the sidebar title. |
| `tui.keybinds.executePlan` | `"<leader>f"` | Open the execution dialog. Avoid `<leader>e`, which conflicts with opencode's built-in `editor_open`. |
| `tui.keybinds.dashboard` | `""` | Optional keybind for opening the dashboard. Empty registers the command without a default binding. |

## Dashboard

| Option | Default | Description |
|---|---:|---|
| `dashboard.events.source` | `"server"` | Live event source: `server`, `tui`, or `none`. |
| `dashboard.events.serverUrl` | `""` | Optional OpenCode server URL for the global event stream. Required for standalone dashboard live events. |
| `dashboard.events.types` | curated session list | Allowlist of server event types forwarded to the feed. |

The bundled config currently sets `dashboard.events.types` to `["session.idle", "session.created", "session.updated", "session.error"]`. If omitted, the runtime curated set also includes `session.status`, `session.deleted`, `message.updated`, `message.part.updated`, and `message.part.removed`.

## Sandbox

See [Sandbox](sandbox.md) for detailed behavior and security notes.

| Option | Default | Description |
|---|---:|---|
| `sandbox.enabled` | `true` | Enable sandboxed execution when Docker is available. |
| `sandbox.mode` | `"docker"` | Sandbox mode. Docker is currently the only supported mode. |
| `sandbox.image` | `"oc-forge-sandbox:latest"` | Docker image for sandbox containers. |
| `sandbox.resources.memory` | `"8g"` | Container memory limit. |
| `sandbox.resources.memorySwap` | unset | Optional memory+swap limit. No default is applied. |
| `sandbox.resources.cpus` | `"4"` | CPU count. |
| `sandbox.resources.shmSize` | `"1g"` | Shared memory size. |
| `sandbox.mountProjectReadonly` | `true` | Mount the source project read-only. |
| `sandbox.projectMountPath` | `"/project"` | Container path for the read-only source project mount. |
| `sandbox.mounts` | `[]` | Additional custom bind mounts. |
| `sandbox.network.hostGateway` | `true` | Enable `host.docker.internal` gateway. |
| `sandbox.network.env` | `[]` | Host environment variables to pass into the container via temp env file. |

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
