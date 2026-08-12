# Sandbox

Forge can run loop iterations or one selected host session inside an isolated `msb` sandbox — a microVM booted by the [microsandbox](https://microsandbox.dev) CLI — while keeping the active project directory mounted at its identical host path for fast host/sandbox file sharing.

See also: [Configuration](configuration.md), [Tools](tools.md), [Loop System](loop-system.md).

## Prerequisites

- The `msb` CLI installed — there is **no account and no login step**. Install with:
  ```bash
  curl -fsSL https://install.microsandbox.dev | sh
  ```
  Verify the host is ready with `msb doctor` (an alias of `msb self doctor`), which checks the hypervisor prerequisites.
- A host that can run microVMs: Linux with KVM, macOS on Apple silicon, or Windows 11 with Windows Hypervisor Platform.
- Docker, used only to build the sandbox image (see below) — the msb runtime itself does not need it.

Forge probes availability with `msb doctor` bounded at 30s. A probe that does not answer is treated as *indeterminate* rather than "daemon down": Forge logs and continues, letting the actual sandbox operation report the authoritative error. Only a host that answers definitively (or a missing CLI) fails a loop launch with remediation advice.

Build and load the bundled image:

```bash
docker build -t oc-forge-sandbox:latest container/
docker save oc-forge-sandbox:latest -o forge-sandbox.tar
msb load --input forge-sandbox.tar --tag oc-forge-sandbox:latest
```

`msb load` registers the archive under the tag Forge looks up (`sandbox.image`, default `oc-forge-sandbox:latest`); list loaded images with `msb images --format json`.

The default image includes Node.js 24, pnpm, Bun, Python 3 + uv, ripgrep, git, and jq. The image no longer ships an in-VM Docker Engine (see [Nested Docker is gone](#nested-docker-is-gone)).

The sandbox image grants the `agent` user passwordless sudo, so loops can install whatever software they need at runtime. Commands arrive via `msb exec` without `-u`, so they run as the image's `USER agent` (keeping host-mapped worktree files owned by the host user); system-wide installs use an explicit `sudo` prefix, for example `sudo apt-get install ruby`.

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

Then run `Build sandbox template` from the command palette. Changing the option does not modify an already-loaded image; rebuild it explicitly. The equivalent manual Docker build is:

```bash
docker build \
  --build-arg INSTALL_BROWSER_CONTROL=true \
  -t oc-forge-sandbox:latest \
  container/
docker save oc-forge-sandbox:latest -o forge-sandbox.tar
msb load --input forge-sandbox.tar --tag oc-forge-sandbox:latest
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
3. The active directory, the read-only source project (when `sandbox.mountProjectReadonly` is enabled), and the worktree's git metadata directory are mounted at their identical host paths, so absolute paths resolve the same on both sides. There is no `/workspace` or `/project` container path.
4. Shell commands and search tools execute inside the sandbox; file tools stay on the host, so LSP and editor integration continue to work.

The read-only project mount is dropped whenever it would nest over the writable worktree — which is the default forge layout, where the worktree lives inside the source project — so `sandbox.mountProjectReadonly` is effectively inert there. The worktree stays writable and the git metadata directory is mounted read-write alongside it, so in-sandbox git works and multiple loops in the same project each mount their worktree plus the shared git metadata independently.

## Shell Routing

Sandbox loops use opencode's native `bash` tool — streaming output, truncation with spill-to-file, timeouts, and abort all behave exactly as in a normal session. Routing happens underneath the tool:

> Requires opencode >= 1.15.5 (the session-aware `shell.env` plugin hook). Enforced via the `engines.opencode` field in Forge's package.json: older opencode versions refuse to load the plugin instead of silently running sandbox loop commands on the host.

1. Forge points opencode's `shell` config at a generated shim (`<dataDir>/forge-shell`).
2. On every bash tool call, Forge's `shell.env` hook resolves the session. Sessions belonging to an active sandbox loop, or to the acknowledged host-session selection, get `FORGE_SANDBOX_CONTAINER` injected; descendants such as Task-tool subagents inherit the same routing. The shim then runs the command via `msb exec "$FORGE_SANDBOX_CONTAINER" --no-tty -w "$PWD" -- bash "$@"`.
3. Sessions with no expected sandbox get no container env, and the shim execs the host shell unchanged (respecting a user-configured `shell` via `FORGE_HOST_SHELL`). Active loop routing always takes precedence over host-session preference.

The shim fails closed: if the sandbox is expected but `msb exec` fails (or the loop sandbox cannot be restored), the command errors — it never silently runs on the host. `msb exec` propagates the guest command's exit code verbatim, so the bash tool keeps seeing real exit statuses.

## Tool Behavior

| Tool category | Behavior in a sandboxed session |
|---|---|
| Shell | Native `bash` tool, executed inside the loop sandbox via the shell shim. |
| Search tools | `glob` and `grep` route through the `msb exec` execution hooks. |
| File tools | `read`, `write`, and `edit` operate on the host filesystem. |
| Git operations managed by Forge | Worktree commits, cleanup, and branch management are handled on the host. |

## Network Access

The msb egress proxy is deny-by-default: outbound access is blocked except for hosts explicitly allowed, and the host's loopback interface is unreachable from inside the sandbox. Allow specific hosts with `sandbox.network.allow`:

```jsonc
{
  "sandbox": {
    "network": {
      "allow": ["registry.npmjs.org"]
    }
  }
}
```

Forge applies the rules at sandbox **create time**: every sandbox is created with `--net-default deny`, an explicit `--net-rule allow@dns`, and one `--net-rule allow@<host>` per configured host. Because msb rules are per sandbox (not daemon-global), adopting an existing sandbox never re-applies egress rules to a live sandbox.

## Environment Passthrough

Select host environment variables can be injected into the sandbox at create time:

```jsonc
{
  "sandbox": {
    "network": {
      "env": ["DATABASE_URL", "API_KEY"]
    }
  }
}
```

Forge passes each name as the bare `-e <NAME>` form, so msb resolves the value from its own environment and the value never appears on forge's command line (or in `ps` output). Only names that are set in the host process are injected; unset names are skipped and logged.

## Secrets

Host-held credentials are bound with `sandbox.network.secrets` instead of `env`. A secret **never enters the guest**: msb keeps a host-side source reference to the environment variable, exposes a `$MSB_<ENV>` placeholder inside the sandbox, and substitutes the real value only for the listed hosts at the network boundary.

```jsonc
{
  "sandbox": {
    "network": {
      "secrets": [
        { "env": "GITHUB_TOKEN", "hosts": ["api.github.com"] }
      ]
    }
  }
}
```

Each entry maps to `msb create --secret <env>@<hosts>`. Adopting an existing sandbox (for example after a plugin restart) converges the bound secrets with `msb modify`: `--secret <env>@<hosts>` refreshes the current value of every configured entry, and `--secret-rm <env>` drops entries that are no longer configured. A refresh failure is logged and never blocks a loop from starting.

Security notes:

- Only pass variables you are willing to expose to the sandbox. Plain variables listed in `network.env` are readable inside the guest.
- The previous per-sandbox plaintext env file under `<dataDir>/sandbox-env/` is **gone**: nothing is written to disk, and the real secret value is stored only on the host.

## Read-Only Project Mount

By default, Forge mounts the source project directory read-only at its identical host path.

| Option | Default | Description |
|---|---:|---|
| `sandbox.mountProjectReadonly` | `true` | Enable the read-only source project mount. |

The loop worktree remains writable. When the read-only project mount would nest over the writable worktree (the default forge layout), it is dropped instead: inside the sandbox the outermost mount's read-only flag applies to the whole subtree, so a read-only ancestor would silently make the worktree read-only. The worktree and the shared git metadata directory are mounted read-write in that case.

## Git Metadata and Hooks

The worktree's git metadata directory is mounted read-write so git works inside the sandbox (`status`, `log`, `diff`, and commits all resolve against the real repository). Two guards keep that from becoming a path out of the sandbox:

- `<git-common-dir>/hooks` is mounted **read-only**, so a sandboxed agent cannot plant a hook that the user's own git would later execute on the host.
- Every git command Forge itself runs is invoked with `core.hooksPath` disabled, so no repository hook runs on the host — including one reached through a `core.hooksPath` entry in the repo-local config, which cannot be mounted read-only because msb workspaces are directories, not files.

Consequences: tools that install hooks into `.git/hooks` (for example `pre-commit install`, or Husky v4) fail inside the sandbox — hook managers that keep hooks in the working tree and point `core.hooksPath` at them still work. Forge's own scratch-branch commits never run repository hooks.

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

## Nested Docker is gone

The sandbox image no longer ships an in-VM Docker Engine. msb runs its own `agentd` as PID 1, so an image entrypoint that starts `dockerd` would never execute, and the in-VM Docker Engine the image used to ship is dead weight under msb. It was deliberately dropped: Docker remains required on the **host** to build the image, but loops can no longer build or run containers inside the sandbox. Restoring nested Docker would require an msb `--init`/scripts bootstrap and is out of scope.

## Sandbox Lifecycle

msb sandboxes are reusable: `msb exec` resolves a stopped or crashed sandbox by starting it in place, so a stop is never a correctness problem — only a restart. A stop is a full VM reboot that destroys in-memory state while on-disk state persists. Forge adopts an existing running or stopped sandbox without recreating it (reusing the same `forge-<worktree>` name), and relies on msb's start-in-place resolution instead of holding a separate keep-alive exec open.

## Large Command Output

Shell output truncation is handled by opencode's native bash tool: when output exceeds the tool limit, the full output is spilled to opencode's tool-output directory on the host (readable from loop sessions, see below). The worktree `.forge/` scratch directory is added to git exclude so forge-written files are not committed.

## Tool-Output Access

opencode spills large tool outputs to its truncation directory (`<opencode-data>/tool-output`, e.g. `~/.local/share/opencode/tool-output`) and references the saved file by absolute host path. Forge makes those overflow files readable from loop and audit sessions in two complementary ways:

- **Sandbox tools** (`bash`, `glob`, `grep`): the directory is bind-mounted **read-only at the identical sandbox path**, so the same absolute path opencode reports resolves inside the sandbox. The mount is added automatically when the directory exists; it is skipped when missing or already covered by the workspace mount.
- **Host file tools** (`read`): the directory is granted an `external_directory` allow rule in the loop/audit permission ruleset (layered after the blanket external-directory deny), so reads succeed without prompting in the unattended loop — the ruleset's blanket allow covers the `read` permission itself, but a `loop.permissions` rule that denies or asks for `read` is layered after these grants and still applies. All other external directories remain denied unless added via `loop.allowExternalDirectories`.

opencode's temp directory (`<os-tmp>/opencode` — the path opencode's bash tool advertises to agents as pre-approved scratch space) is handled the same way, but for writes: it is granted an `external_directory` allow rule for host file tools **and** bind-mounted read-write at the identical sandbox path, so scratch files an agent writes at that path resolve identically on the host and inside the sandbox. It is opencode's own directory — Forge provides no separate scratch directory, and agents can use the advertised OS temp path without issue.

## Resource Defaults

| Option | Default | msb flag |
|---|---:|---|
| `sandbox.resources.memory` | `"8g"` | `msb create -m` |
| `sandbox.resources.cpus` | `"4"` | `msb create -c` (integer-only) |
