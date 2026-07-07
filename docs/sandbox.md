# Sandbox

Forge can run loop iterations inside an isolated Docker container while keeping the loop worktree bind-mounted for fast host/container file sharing.

See also: [Configuration](configuration.md), [Tools](tools.md), [Loop System](loop-system.md).

## Prerequisites

- Docker running on your machine.
- Sandbox image available as `oc-forge-sandbox:latest`, unless configured otherwise.

Build the bundled image:

```bash
docker build -t oc-forge-sandbox:latest container/
```

The image includes Node.js 24, pnpm, Bun, Python 3 + uv, ripgrep, git, jq, and Docker-in-Docker support.

## How It Works

1. Forge creates an isolated git worktree for the loop.
2. If sandboxing is enabled and Docker is available, Forge starts one container for that loop.
3. The worktree is bind-mounted writable at `/workspace` and at its identical host path, so absolute paths resolve the same on both sides.
4. The source project is optionally mounted read-only at `/project` for reference.
5. Shell commands and search tools execute inside the container; file tools stay on the host, so LSP and editor integration continue to work.

## Shell Routing

Sandbox loops use opencode's native `bash` tool — streaming output, truncation with spill-to-file, timeouts, and abort all behave exactly as in a normal session. Routing happens underneath the tool:

> Requires opencode >= 1.15.5 (the session-aware `shell.env` plugin hook). Enforced via the `engines.opencode` field in Forge's package.json: older opencode versions refuse to load the plugin instead of silently running sandbox loop commands on the host.

1. Forge points opencode's `shell` config at a generated shim (`<dataDir>/forge-shell`).
2. On every bash tool call, Forge's `shell.env` hook resolves the session to its loop. Sessions belonging to an active sandbox loop (including Task-tool subagents) get `FORGE_SANDBOX_CONTAINER` injected; the shim then runs the command via `docker exec -w "$PWD" <container> bash`.
3. All other sessions get no container env, and the shim execs the host shell unchanged (respecting a user-configured `shell` via `FORGE_HOST_SHELL`).

The shim fails closed: if the container is expected but `docker exec` fails (or the loop container cannot be restored), the command errors — it never silently runs on the host.

## Tool Behavior

| Tool category | Behavior in sandbox loop |
|---|---|
| Shell | Native `bash` tool, executed inside the loop container via the shell shim. |
| Search tools | `glob` and `grep` route through Docker execution hooks. |
| File tools | `read`, `write`, and `edit` operate on the host filesystem. |
| Git operations managed by Forge | Worktree commits, cleanup, and branch management are handled on the host. |

## Reaching Host Services

The sandbox can reach host services at `host.docker.internal:<port>` when `sandbox.network.hostGateway` is enabled. It defaults to `true`.

Disable it:

```jsonc
{
  "sandbox": {
    "network": {
      "hostGateway": false
    }
  }
}
```

## Environment Passthrough

Select host environment variables can be passed into the container:

```jsonc
{
  "sandbox": {
    "network": {
      "env": ["DATABASE_URL", "API_KEY"]
    }
  }
}
```

Values are written to a temporary Docker `--env-file` during container startup and are not persisted by Forge.

Security note: only pass variables you are willing to expose to the sandbox.

## Read-Only Project Mount

By default, Forge mounts the source project directory read-only at `/project`.

| Option | Default | Description |
|---|---:|---|
| `sandbox.mountProjectReadonly` | `true` | Enable the read-only source project mount. |
| `sandbox.projectMountPath` | `"/project"` | Container path for the mount. |

The loop worktree at `/workspace` remains writable.

## Custom Bind Mounts

Configure additional bind mounts with `sandbox.mounts`:

```jsonc
{
  "sandbox": {
    "mounts": [
      { "host": "/abs/host/reference", "container": "/reference" },
      { "host": "/abs/host/cache", "container": "/cache", "readonly": false }
    ]
  }
}
```

Rules:

- `host` and `container` must be absolute paths.
- Mounts default to read-only.
- Invalid entries are skipped and logged.
- Mounts cannot collide with reserved paths such as `/workspace`, the project mount, git metadata, or earlier custom mounts.

Security note: read-write custom mounts give the sandbox write access to host paths. Use them only for trusted directories.

## Docker-in-Docker

Each sandbox container runs a nested Docker daemon so loops can build and run containers without touching the host Docker daemon.

- Each loop gets isolated image/container storage.
- The container is launched privileged because the nested daemon requires root.
- Agent shell commands run as the host UID:GID via `docker exec --user`, so files written to the bind-mounted worktree are owned by the host user.
- The Docker socket group is set to the host GID so the non-root exec user can access the nested daemon.

### Socket Access Guarantee

Because agent commands run as the non-root host UID:GID, the nested daemon's socket must be reachable by that user — otherwise Docker-based tests fail with `permission denied while trying to connect to the docker API`, which looks like "no daemon" even though dockerd is healthy. Forge guarantees access in two layers:

1. **Entrypoint (race-free).** After the nested daemon is confirmed ready, the entrypoint sets the socket group to `FORGE_HOST_GID` (`chgrp` + `g+rw`). Doing this *after* readiness avoids the startup race where dockerd re-applies socket permissions. When the GID is unknown, it falls back to a world-accessible socket (`chmod 666`) — safe because the container is per-loop, isolated, and already privileged.
2. **Manager verification.** On container start, `manager.start()` polls `docker version` as the exec user. On success it logs the reachable server version; if the daemon stays unreachable it logs a clear, actionable error (pointing at `/var/log/dockerd.log` and the socket group) instead of letting the loop silently surface "no daemon". This check is non-fatal so loops that don't use Docker still run.

## Large Command Output

Shell output truncation is handled by opencode's native bash tool: when output exceeds the tool limit, the full output is spilled to opencode's tool-output directory on the host (readable from loop sessions, see below). The worktree `.forge/` scratch directory is added to git exclude so forge-written files are not committed.

## Tool-Output Access

opencode spills large tool outputs to its truncation directory (`<opencode-data>/tool-output`, e.g. `~/.local/share/opencode/tool-output`) and references the saved file by absolute host path. Forge makes those overflow files readable from loop and audit sessions in two complementary ways:

- **Container tools** (`bash`, `glob`, `grep`): the directory is bind-mounted **read-only at the identical container path**, so the same absolute path opencode reports resolves inside the container. The mount is added automatically when the directory exists; it is skipped when missing or already covered by the workspace mount.
- **Host file tools** (`read`): the directory is granted an `external_directory` allow rule in the loop/audit permission ruleset (layered after the blanket external-directory deny), so reads succeed without prompting in the unattended loop. All other external directories remain denied unless added via `loop.allowExternalDirectories`.

## Resource Defaults

| Option | Default | Docker flag |
|---|---:|---|
| `sandbox.resources.memory` | `"8g"` | `--memory` |
| `sandbox.resources.memorySwap` | unset | `--memory-swap` |
| `sandbox.resources.cpus` | `"4"` | `--cpus` |
| `sandbox.resources.shmSize` | `"1g"` | `--shm-size` |

`memorySwap` has no implicit default. Configure it explicitly if Docker should receive `--memory-swap`.
