# Sandbox

Forge can run loop iterations or one selected host session inside an isolated `sbx` sandbox while keeping the active project directory mounted at its identical host path for fast host/sandbox file sharing.

See also: [Configuration](configuration.md), [Tools](tools.md), [Loop System](loop-system.md).

## Prerequisites

- The `sbx` CLI installed and authenticated. Run `sbx login` to authenticate.
- The `sbx` daemon (`sandboxd`) running. Start it with `sbx daemon start` if it is not already up.
- A platform the `sbx` daemon supports: macOS 14+ on Apple silicon, Windows 11 with Hypervisor Platform, or Ubuntu 24.04+ with KVM.
- Docker, used only to build the sandbox template (see below).

Build and load the bundled template:

```bash
docker build -t oc-forge-sandbox:latest container/
docker save oc-forge-sandbox:latest -o forge-sandbox.tar
sbx template load forge-sandbox.tar
```

The default image includes Node.js 24, pnpm, Bun, Python 3 + uv, ripgrep, git, jq, and a native Docker daemon inside each sandbox.

### Browser Control (opt-in)

Chromium and Browser Control add a substantial browser payload, so they are excluded by default. Enable them for future image builds:

```jsonc
{
  "sandbox": {
    "imageFeatures": {
      "browserControl": true
    }
  }
}
```

Then run `Build sandbox template` from the command palette. Changing the option does not modify an already-loaded template; rebuild it explicitly. The equivalent manual Docker build is:

```bash
docker build \
  --build-arg INSTALL_BROWSER_CONTROL=true \
  -t oc-forge-sandbox:latest \
  container/
docker save oc-forge-sandbox:latest -o forge-sandbox.tar
sbx template load forge-sandbox.tar
```

The resulting image provides `browser-control`, `browser-control-mcp`, Chromium as `chromium`, and the unpacked extension at `/opt/browser-control-extension`.

Browser Control connects to a browser in the same sandbox. Launch Chromium with the packaged extension path resolved to its installation directory:

```bash
extension="$(readlink -f /opt/browser-control-extension)"
xvfb-run -a chromium \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-extensions-except="$extension" \
  --load-extension="$extension" \
  --user-data-dir=/opt/forge/.browser-control-profile
```

It cannot control a browser running on the host because sandbox networking cannot reach the host loopback interface.

## How It Works

1. A sandbox loop uses its isolated git worktree. A host-session sandbox instead uses the project root selected from the TUI.
2. Forge creates one sandbox per loop, or one project-scoped host-session sandbox shared by plugin instances in the process.
3. The active directory and the read-only source project (when `sandbox.mountProjectReadonly` is enabled) are mounted at their identical host paths, so absolute paths resolve the same on both sides. There is no `/workspace` or `/project` container path.
4. Shell commands and search tools execute inside the sandbox; file tools stay on the host, so LSP and editor integration continue to work.

The read-only project mount is dropped whenever the worktree's git directories live inside the source project (the default forge layout), so `sandbox.mountProjectReadonly` is effectively inert there.

## Shell Routing

Sandbox loops use opencode's native `bash` tool — streaming output, truncation with spill-to-file, timeouts, and abort all behave exactly as in a normal session. Routing happens underneath the tool:

> Requires opencode >= 1.15.5 (the session-aware `shell.env` plugin hook). Enforced via the `engines.opencode` field in Forge's package.json: older opencode versions refuse to load the plugin instead of silently running sandbox loop commands on the host.

1. Forge points opencode's `shell` config at a generated shim (`<dataDir>/forge-shell`).
2. On every bash tool call, Forge's `shell.env` hook resolves the session. Sessions belonging to an active sandbox loop, or to the acknowledged host-session selection, get `FORGE_SANDBOX_CONTAINER` injected; descendants such as Task-tool subagents inherit the same routing. The shim then runs the command via `sbx exec -w "$PWD" <sandbox> bash`.
3. Sessions with no expected sandbox get no container env, and the shim execs the host shell unchanged (respecting a user-configured `shell` via `FORGE_HOST_SHELL`). Active loop routing always takes precedence over host-session preference.

The shim fails closed: if the sandbox is expected but `sbx exec` fails (or the loop sandbox cannot be restored), the command errors — it never silently runs on the host.

## Tool Behavior

| Tool category | Behavior in a sandboxed session |
|---|---|
| Shell | Native `bash` tool, executed inside the loop sandbox via the shell shim. |
| Search tools | `glob` and `grep` route through the `sbx exec` execution hooks. |
| File tools | `read`, `write`, and `edit` operate on the host filesystem. |
| Git operations managed by Forge | Worktree commits, cleanup, and branch management are handled on the host. |

## Network Access

The `sbx` network proxy is deny-by-default: outbound access is blocked except for hosts explicitly allowed, and the host's loopback interface is unreachable from inside the sandbox. Allow specific hosts with `sandbox.network.allow`:

```jsonc
{
  "sandbox": {
    "network": {
      "allow": ["registry.npmjs.org"]
    }
  }
}
```

Forge applies each entry with `sbx policy allow network <host>` when a sandbox starts. Because the daemon persists policy, a daemon restart under a live plugin leaves the allowlist unapplied until the manager is recreated on the next plugin start.

## Environment Passthrough

Select host environment variables can be passed into each sandbox command:

```jsonc
{
  "sandbox": {
    "network": {
      "env": ["DATABASE_URL", "API_KEY"]
    }
  }
}
```

Values are written to a sandbox-lifetime env file on the host that is attached to every `sbx exec` via `--env-file`. The file is removed when the sandbox is stopped.

Security note: only pass variables you are willing to expose to the sandbox.

## Read-Only Project Mount

By default, Forge mounts the source project directory read-only at its identical host path.

| Option | Default | Description |
|---|---:|---|
| `sandbox.mountProjectReadonly` | `true` | Enable the read-only source project mount. |

The loop worktree remains writable.

## Custom Bind Mounts

Configure additional bind mounts with `sandbox.mounts`. Each entry is a host directory mounted at its identical host path — there is no `container` field, because the path is the same on both sides:

```jsonc
{
  "sandbox": {
    "mounts": [
      { "host": "/abs/host/reference" },
      { "host": "/abs/host/cache", "readonly": false }
    ]
  }
}
```

Rules:

- `host` must be an absolute path.
- Mounts default to read-only.
- Invalid entries are skipped and logged.
- Mounts cannot equal or nest inside reserved paths such as the worktree, the project mount, git metadata, or earlier custom mounts.

Security note: read-write custom mounts give the sandbox write access to host paths. Use them only for trusted directories.

## Docker

Each sbx sandbox has its own Docker daemon natively, so loops can build and run containers (for example end-to-end tests) without touching the host Docker daemon. Every sandbox gets isolated image and container storage.

## Large Command Output

Shell output truncation is handled by opencode's native bash tool: when output exceeds the tool limit, the full output is spilled to opencode's tool-output directory on the host (readable from loop sessions, see below). The worktree `.forge/` scratch directory is added to git exclude so forge-written files are not committed.

## Tool-Output Access

opencode spills large tool outputs to its truncation directory (`<opencode-data>/tool-output`, e.g. `~/.local/share/opencode/tool-output`) and references the saved file by absolute host path. Forge makes those overflow files readable from loop and audit sessions in two complementary ways:

- **Sandbox tools** (`bash`, `glob`, `grep`): the directory is bind-mounted **read-only at the identical sandbox path**, so the same absolute path opencode reports resolves inside the sandbox. The mount is added automatically when the directory exists; it is skipped when missing or already covered by the workspace mount.
- **Host file tools** (`read`): the directory is granted an `external_directory` allow rule in the loop/audit permission ruleset (layered after the blanket external-directory deny), so reads succeed without prompting in the unattended loop. All other external directories remain denied unless added via `loop.allowExternalDirectories`.

## Resource Defaults

| Option | Default | sbx flag |
|---|---:|---|
| `sandbox.resources.memory` | `"8g"` | `--memory` |
| `sandbox.resources.cpus` | `"4"` | `--cpus` (integer-only) |
