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
3. The worktree is bind-mounted at `/workspace` and remains writable.
4. The source project is optionally mounted read-only at `/project` for reference.
5. Sandbox-aware shell/search tools execute inside the container.
6. Host-side file tools still operate on the host filesystem, so LSP and editor integration continue to work.

## Tool Behavior

| Tool category | Behavior in sandbox loop |
|---|---|
| Shell/search tools | `bash`, `glob`, and `grep` route through Docker execution hooks. |
| Forge `sh` tool | Runs commands inside the loop's sandbox container when available. |
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
- Mounts cannot equal or nest inside reserved paths such as `/workspace`, the project mount, git metadata, or earlier custom mounts.

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

When sandbox shell output exceeds the tool limit, overflow is written to `<worktree>/.forge/tmp/`. The worktree `.forge/` directory is added to git exclude so spill files are not committed.

## Tool-Output Access

opencode spills large tool outputs to its truncation directory (`<opencode-data>/tool-output`, e.g. `~/.local/share/opencode/tool-output`) and references the saved file by absolute host path. Forge makes those overflow files readable from loop and audit sessions in two complementary ways:

- **Container tools** (`sh`, `glob`, `grep`): the directory is bind-mounted **read-only at the identical container path**, so the same absolute path opencode reports resolves inside the container. The mount is added automatically when the directory exists; it is skipped when missing or already covered by the workspace mount.
- **Host file tools** (`read`): the directory is granted an `external_directory` allow rule in the loop/audit permission ruleset (layered after the blanket external-directory deny), so reads succeed without prompting in the unattended loop. All other external directories remain denied unless added via `loop.allowExternalDirectories`.

## Resource Defaults

| Option | Default | Docker flag |
|---|---:|---|
| `sandbox.resources.memory` | `"8g"` | `--memory` |
| `sandbox.resources.memorySwap` | unset | `--memory-swap` |
| `sandbox.resources.cpus` | `"4"` | `--cpus` |
| `sandbox.resources.shmSize` | `"1g"` | `--shm-size` |

`memorySwap` has no implicit default. Configure it explicitly if Docker should receive `--memory-swap`.
