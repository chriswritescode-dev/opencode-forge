# Sandbox

Forge can run loop iterations or one selected host session inside an isolated sandbox — either an `sbx` sandbox (CLI + daemon) or a `smolvm` machine (see [smolvm Mode](#smolvm-mode)) — while keeping the active project directory mounted at its identical host path for fast host/sandbox file sharing.

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

## Keep-Alive

`sbx` auto-stops a sandbox roughly 35 seconds after the last exec session ends. Forge holds one long-lived "sentinel" exec per active sandbox — an in-container `sleep 600` — and renews it when it returns. `sbx` keeps a sandbox running as long as an exec session is in flight, so the sentinel holds it warm with no polling. The 10-minute bound means that if the forge process dies without cleanup, the sandbox stops within that bound rather than staying up forever. On plugin cleanup the sentinel is aborted and the sandboxes are left alone, matching Forge's contract of preserving active loops across restarts. Holding a session is the same "sentinel connection" approach Docker's own `sbx cp` and `sbx kit add` use.

Cold starts are cheap: roughly 0.9s for the first command after a stop, vs ~0.16s warm. Keep-alive is not about latency — a stop is a full VM reboot that destroys in-memory state, while on-disk state (Docker images, containers, and files) persists across it. And because `sbx exec` auto-starts a stopped sandbox, keep-alive is never required for correctness of a single command.

## smolvm Mode

Forge can run sandboxed loops on the `smolvm` CLI (smolmachines.com) instead of the `sbx` daemon. Enable it with:

```jsonc
{
  "sandbox": {
    "mode": "smolvm"
  }
}
```

### Requirements

- The `smolvm` CLI installed: `curl -sSL https://smolmachines.com/install.sh | bash`. There is no daemon — the `smolvm` binary embeds libkrun and drives the local hypervisor directly.
- A supported platform: macOS 11+ on Apple silicon, Linux with `/dev/kvm`, or Windows x86_64 with Windows Hypervisor Platform.
- Docker, used only to build the sandbox template (see below).

### Template Flow

The bundled template is still built with Docker; only the final step differs. Forge keeps a managed image store at `<dataDir>/smolvm-images/`:

```bash
docker build -t oc-forge-sandbox:latest container/
docker save oc-forge-sandbox:latest -o forge-sandbox.tar
# Forge stores the tar as <dataDir>/smolvm-images/<sanitized-ref>.tar
```

Each sandbox create resolves `--image` from that store and passes the tar to `smolvm machine create --image <tar>`, which consumes the `docker save` archive directly — there is no template-store command to run. A registry-qualified ref containing `/` (for example `docker.io/library/oc-forge-sandbox:latest`) is passed through to `machine create` unchanged, letting smolvm pull it. The "Build sandbox template" palette command builds and stores the tar under the active mode.

### Network Semantics

smolvm machines are created with `--net` and have no global proxy: egress is unrestricted by default. `sandbox.network.allow` maps to per-machine `--allow-host` flags applied at create time, so changing the list after a sandbox exists requires recreating the sandbox. Under smolvm an empty (or absent) allow list means unrestricted egress — the opposite of sbx's deny-by-default proxy.

smolvm resolves every `--allow-host` as a literal hostname when the machine starts, and an unresolvable one fails the create outright — there is no wildcard. A wildcard entry (for example sbx's allow-everything `**`) therefore drops **all** `--allow-host` flags, which is the faithful translation: no flags already means unrestricted egress.

Inbound is closed and guest ports never collide with host ports. Forge passes no `-p`, so a guest listener publishes nothing and binds nothing on the host. The machine has its own kernel and network stack, so a guest process binds a port the host is already using, each side keeps serving its own process on that number, and inside the guest `127.0.0.1:<port>` resolves to the guest's own listener.

**Host loopback is reachable for ports the guest is not using.** smolvm's default `tsi` network backend impersonates guest sockets on the host, so a guest connection to `127.0.0.1:<port>` falls through to a *host* service on that port whenever the guest has nothing bound there — guest listeners take precedence, but they are the only thing shadowing the host. sbx's proxy blocks host loopback outright, so this is a smolvm-only exposure: treat host-local dev servers, databases, and unauthenticated ports as reachable from a smolvm loop. Egress filtering (`--allow-host`/`--allow-cidr`) is the only mitigation and requires the `virtio-net` backend, which bundled libkrun builds may not expose; when they do not, any `sandbox.network.allow` entry makes the machine fail to start rather than silently run unfiltered.

### Docker in the Machine

Each smolvm sandbox runs the image's own Docker daemon, matching the in-sandbox Docker that `sbx` provides natively. smolvm boots an image as a bare agent and never runs its entrypoint or init scripts, so Forge starts the daemon itself after every machine start (creation and transparent restart alike). Three guest details shape the command:

- The machine root filesystem is itself an overlay and `overlay2` cannot stack on it, so the daemon's data root is pinned to the machine's ext4 `/storage` disk (`--data-root=/storage/docker`). Unlike the bind mount in smolvm's docker-in-vm example, a data root survives stop/start.
- `smolvm machine exec` applies only the user's primary group, so the default `root:docker` socket is unreachable from a loop command. The daemon is started with `--group agent`, matching the image user's primary group.
- Startup is idempotent and non-fatal: it no-ops when the image ships no `dockerd` or a daemon already answers, and a daemon that refuses to start degrades to "no Docker in this sandbox" (logged) rather than failing sandbox creation.

### Environment Passthrough

`sandbox.network.env` variables are written to the same host-side env file. Because `smolvm machine exec` has no `--env-file` flag, Forge mounts the env directory read-only at its identical host path and each exec sources the file in-guest before running the command.

### Shell Routing

The generated shell shim routes bash-tool commands through `smolvm machine exec --name <sandbox> -- bash -c <payload>` instead of `sbx exec`, applying the working directory and env file inside the guest (smolvm exec has no `-w` or `--env-file` flags). It fails closed exactly like the sbx shim: if the machine is expected but `smolvm machine exec` fails, the command errors rather than silently running on the host.

### Keep-Alive and Recovery

smolvm machines do not auto-stop the way `sbx` sandboxes do (~35s idle stop), so the sentinel exec is harmless there. If a machine is stopped out-of-band, the next exec fails with a stopped-machine error and Forge restarts it transparently before retrying the command once.

## Large Command Output

Shell output truncation is handled by opencode's native bash tool: when output exceeds the tool limit, the full output is spilled to opencode's tool-output directory on the host (readable from loop sessions, see below). The worktree `.forge/` scratch directory is added to git exclude so forge-written files are not committed.

## Tool-Output Access

opencode spills large tool outputs to its truncation directory (`<opencode-data>/tool-output`, e.g. `~/.local/share/opencode/tool-output`) and references the saved file by absolute host path. Forge makes those overflow files readable from loop and audit sessions in two complementary ways:

- **Sandbox tools** (`bash`, `glob`, `grep`): the directory is bind-mounted **read-only at the identical sandbox path**, so the same absolute path opencode reports resolves inside the sandbox. The mount is added automatically when the directory exists; it is skipped when missing or already covered by the workspace mount.
- **Host file tools** (`read`): the directory is granted an `external_directory` allow rule in the loop/audit permission ruleset (layered after the blanket external-directory deny), so reads succeed without prompting in the unattended loop — the ruleset's blanket allow covers the `read` permission itself, but a `loop.permissions` rule that denies or asks for `read` is layered after these grants and still applies. All other external directories remain denied unless added via `loop.allowExternalDirectories`.

opencode's temp directory (`<os-tmp>/opencode` — the path opencode's bash tool advertises to agents as pre-approved scratch space) is handled the same way, but for writes: it is granted an `external_directory` allow rule for host file tools **and** bind-mounted read-write at the identical sandbox path, so scratch files an agent writes at that path resolve identically on the host and inside the sandbox. It is opencode's own directory — Forge provides no separate scratch directory, and agents can use the advertised OS temp path without issue.

## Resource Defaults

| Option | Default | sbx flag |
|---|---:|---|
| `sandbox.resources.memory` | `"8g"` | `--memory` |
| `sandbox.resources.cpus` | `"4"` | `--cpus` (integer-only) |
