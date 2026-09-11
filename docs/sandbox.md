# Sandbox

Forge can run loop iterations or one selected host session inside an isolated `msb` sandbox — a microVM booted by the [microsandbox](https://microsandbox.dev) CLI — while keeping the active project directory mounted at its identical host path for fast host/sandbox file sharing.

See also: [Configuration](configuration.md), [Tools](tools.md), [Loop System](loop-system.md).

## Prerequisites

- The `msb` CLI installed — there is **no account and no login step**. Install with:
  ```bash
  curl -fsSL https://install.microsandbox.dev | sh
  ```
  Verify the host is ready with `msb doctor` (an alias of `msb self doctor`), which checks the hypervisor prerequisites. The interactive installer (`bunx opencode-forge`, or `pnpm run setup` from a checkout) offers to run this command for you when it cannot find `msb` on `PATH`.
- A host that can run microVMs: Linux with KVM, macOS on Apple silicon, or Windows 11 with Windows Hypervisor Platform.
- Docker on the host, used only to build the sandbox image (see below) — the msb runtime itself does not need it.

Forge probes availability with `msb doctor` bounded at 30s. A probe that does not answer is treated as *indeterminate* rather than "daemon down": Forge logs and continues, letting the actual sandbox operation report the authoritative error. Only a host that answers definitively (or a missing CLI) fails a loop launch with remediation advice.

Build and load the bundled image:

```bash
docker build -t oc-forge-sandbox:latest container/
docker save oc-forge-sandbox:latest -o forge-sandbox.tar
msb load --input forge-sandbox.tar --tag oc-forge-sandbox:latest
```

`msb load` registers the archive under the tag Forge looks up (`sandbox.image`, default `oc-forge-sandbox:latest`); list loaded images with `msb images --format json`.

The default image includes Node.js 24, pnpm, Bun, Python 3 + uv, ripgrep, git, jq, Obscura, and Docker Engine (see [Nested Docker](#nested-docker)).

The sandbox image grants the `agent` user passwordless sudo, so loops can install whatever software they need at runtime. Commands arrive via `msb exec` without `-u`, so they run as the image's `USER agent` (keeping host-mapped worktree files owned by the host user); system-wide installs use an explicit `sudo` prefix, for example `sudo apt-get install ruby`.

### Obscura

The image ships the Obscura headless browser engine as `obscura` — a Rust-based headless browser with embedded V8, built for web scraping and agent automation. `obscura serve` speaks the Chrome DevTools Protocol, so Puppeteer and Playwright connect to it like headless Chrome:

```bash
obscura serve --port 9222
```

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
2. On every bash tool call, Forge's `shell.env` hook resolves the session. Sessions belonging to an active sandbox loop, or to the acknowledged host-session selection, get `FORGE_SANDBOX_CONTAINER` injected; descendants such as Task-tool subagents inherit the same routing. The shim then runs the command via `msb exec --quiet "$FORGE_SANDBOX_CONTAINER" --no-tty -w "$PWD" -- bash "$@"`.
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

Public egress is **allowed by default**: when `sandbox.network.allow` is omitted — or set to `["*"]` or `["**"]`, the explicit allow-all wildcards — Forge passes no network flags and msb's own default applies, letting the sandbox reach any public host. A wildcard entry anywhere in `network.allow` makes the whole list unrestricted, overriding any narrower entries in the same list. Restriction is opt-in — listing concrete hosts with `sandbox.network.allow` flips the sandbox to restricted egress, where only allow-listed hosts are reachable:

```jsonc
{
  "sandbox": {
    "network": {
      "allow": ["registry.npmjs.org"]
    }
  }
}
```

When any concrete host is configured (including secret destination hosts, which are unioned into the same allow list) and no `*`/`**` entry is present in `sandbox.network.allow`, Forge creates the sandbox with `--net-default deny` plus one `--net-rule allow@<host>` per validated host. Each entry is validated before use; invalid entries are skipped and logged. Verified rejections: a comma (for `--net-rule` a comma separates whole rule tokens, not hosts), a colon (`example.com:443` needs the `example.com:tcp:443` form), an `@`, a wildcard suffix with fewer than two labels (`*.example.com` is valid, `*.com` is rejected), and a bare single-label hostname (msb requires the `domain=` form). The `domain=` and `suffix=` forms pass through. A wildcard in a secret's destination hosts stays invalid — those hosts declare where that secret may be sent, not global egress policy. If every configured host is rejected as invalid, Forge still emits `--net-default deny` with no allow rules and logs that egress is fully denied — it deliberately does not fall back to allow-all, so a config typo cannot silently remove an intended restriction.

Either way, the host's loopback interface remains unreachable from inside the sandbox: the private range is not part of msb's `public` egress group, so a host listener on e.g. `0.0.0.0:18923` stays unreachable via `host.microsandbox.internal` or the gateway IP even when no net flags are passed.

Forge applies the rules at sandbox **create time** only. msb rules are per sandbox (not daemon-global) and `msb modify` has no `--net-rule` flag, so egress rules cannot be changed on a live sandbox: a newly configured host requires the sandbox to be recreated.

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

Each entry maps to `msb create --secret <env>@<hosts>`. Once a sandbox has a secret bound, every `msb exec` fails unless the named host environment variable is present in the environment of the process invoking msb — msb reports `error: invalid config: secret X: host environment variable X is not set`. Because the shell shim inherits opencode's process environment, a variable missing there breaks every sandboxed shell command. The variables named in `sandbox.network.secrets` must therefore be exported in the environment that **launches opencode**, not merely present in an interactive shell. Forge logs an explicit warning naming the variable when a configured secret's host variable is unset.

Adopting an existing sandbox (for example after a plugin restart) converges the bound secrets with `msb modify`: `--secret <env>@<hosts>` refreshes the current value of every configured entry, and `--secret-rm <env>` drops entries that are no longer configured. Convergence runs once per sandbox adoption per plugin instance, not on every liveness check. A refresh failure blocks adoption without marking the sandbox converged, so a later startup can retry.

One placeholder caveat: a secret introduced by `msb modify` on an already-existing sandbox gets a `$<ENV>` placeholder instead of the `$MSB_<ENV>` form, so a newly added secret is most reliable on a freshly created sandbox.

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

## Nested Docker

The sandbox image ships an in-VM Docker Engine, enabled by default. `container/Dockerfile` installs it from Docker's official apt repository — `docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-buildx-plugin`, `docker-compose-plugin` — and the `agent` user is in the `docker` group.

msb runs its own `agentd` as PID 1 and ignores the image's `ENTRYPOINT`/`CMD`, so the daemon cannot start at boot. Instead the image ships `/usr/local/bin/forge-dockerd-start`: idempotent and safe to run concurrently (an `flock` serializes starts), self-elevating via the passwordless sudo rule so `agent` can call it bare, it starts `dockerd` detached with `setsid` and waits up to 60s for readiness, exiting non-zero with the daemon log tail on failure.

`/var/lib/docker` is backed by a real block device, because Docker's `overlayfs` driver cannot run on a virtiofs workspace mount. Forge passes `--mount-named <sandbox>-docker-data:/var/lib/docker:kind=disk,size=<size>`, configurable via `sandbox.resources.dockerDisk` (default `16g`). The disk is sparse, so the default costs no real disk up front.

Named volumes **survive `msb rm`**, so Forge explicitly removes the sandbox's docker data and cache data volumes when it removes the sandbox (and during orphan cleanup) — otherwise a multi-gigabyte volume would leak per loop.

Verified working inside the sandbox: `docker info` reports server 29.7.2 with `storage=overlayfs`, `docker run --rm hello-world` succeeds, `docker compose version` works, and `docker build` works. The daemon survives across separate `msb exec` calls.

Registry pulls work with the default allow-public egress posture and need no extra configuration. Under an opt-in restriction, pulling from Docker Hub requires allow-listing `registry-1.docker.io`, `auth.docker.io`, `production.cloudfront.docker.com`, and the CloudFront blob host (`*.cloudfront.net`).

The image derives from a plain OCI base, keeps the final `USER agent`, and declares no `ENTRYPOINT`/`CMD`. Docker remains required on the **host** to build the image. The built image is roughly 1.65 GB, up from about 1 GB, because Docker Engine is heavy.

## Tool Caches and Disk Space

The sandbox root filesystem is a small overlay (about 4 GB), while package-manager caches grow unbounded: real loops accumulated multi-gigabyte pnpm stores, uv wheel caches, and Rust sdist bootstrap caches (puccinialin) until the root filesystem hit 100%. The image therefore pins every tool cache under `/opt/forge/.cache` (`XDG_CACHE_HOME`), and Forge mounts that directory as a dedicated sparse block device at create time — the same mechanism as the Docker data disk: `--mount-named <sandbox>-cache-data:/opt/forge/.cache:kind=disk,size=<size>`, configurable via `sandbox.resources.cacheDisk` (default `16g`).

msb formats a fresh named disk as root-owned `0755` while `msb exec` runs as `agent`, so Forge makes the mount root `agent`-owned and world-writable (`chown agent:agent` plus `chmod 0777`, non-recursive) in a single exec before the sandbox is registered. World-writable matches the image's build-time posture for `/opt/forge`, which the runtime mount would otherwise shadow, and keeps the tree usable when a command is run under `sudo`. The step is memoized per sandbox and re-applied on adoption, so a sandbox whose preparation failed — or one created by an older Forge build — is healed on the next start instead of being adopted with an unwritable cache.

Caches that do not honor `XDG_CACHE_HOME` are routed into that directory by image environment variables:

| Cache | Variable |
|---|---|
| pnpm content store (pnpm 11 / pnpm 10) | `PNPM_CONFIG_STORE_DIR` / `npm_config_store_dir` = `/opt/forge/.cache/pnpm/store` |
| npm cache | `npm_config_cache=/opt/forge/.cache/npm` |
| uv-managed Pythons | `UV_PYTHON_INSTALL_DIR=/opt/forge/.cache/uv-python` |
| cargo and rustup | `CARGO_HOME` / `RUSTUP_HOME` under `/opt/forge/.cache` |
| Go modules | `GOPATH=/opt/forge/.cache/go` |

CLIs installed globally at image-build time (`fallow`) are a deliberate exception: they are installed with an explicit `--store-dir` under `/opt/forge/.local/share/pnpm/store`. pnpm does not copy a global package into `PNPM_HOME` — the global `node_modules` entry is a symlink chain into the store — so a global built against the cache-disk store would resolve to a dangling symlink the moment the disk is mounted over that path, and the CLI would fail with `Cannot find module`. The build-time store therefore stays on a path no mount shadows, while the environment keeps agent installs on the cache disk.

uv, pip, puccinialin, Playwright browsers, and pnpm's own cache resolve under `XDG_CACHE_HOME` unchanged. The uv-managed interpreters deliberately sit at `uv-python`, *outside* uv's own cache directory (`$XDG_CACHE_HOME/uv`), because `uv cache clean` clears that directory entirely and would otherwise delete interpreters that project virtualenvs link against. Because the store sits on a different filesystem than the mounted project, pnpm copies packages into `node_modules` instead of hard-linking — the same trade the container-internal store already made against the virtiofs project mount.

The image ships `forge-cache-prune`, safe to run as `agent` whenever the sandbox is idle. It clears re-downloadable caches — the pnpm store, npm and uv caches, `cargo/registry`, `cargo/git`, `go/pkg/mod`, and any unrecognized entry — while preserving installed toolchains: `rustup`, the uv-managed Pythons, and the `cargo/bin` and `go/bin` binaries. It then runs `apt-get clean` and `fstrim`, so the freed space is returned to the host's sparse disk image rather than only to the guest. The sandbox context note tells agents about it, so a full cache disk is reclaimed by running it instead of hand-hunting `du`.

The cache volume keeps its contents across sandbox recreation via `--replace`. Sandboxes created before this feature keep their caches on the root filesystem; as a stopgap their root disk can be grown in place (`msb modify <sandbox> --root-disk <size>`, grow-only), but the cache disk itself requires recreating the sandbox (`msb rm <sandbox>`). Changing `sandbox.resources.cacheDisk` does not resize an existing sandbox — see [Resource Defaults](#resource-defaults).

## Sandbox Lifecycle

msb sandboxes are reusable: `msb exec` resolves a stopped or crashed sandbox by starting it in place, so a stop is never a correctness problem — only a restart. A stop is a full VM reboot that destroys in-memory state while on-disk state persists. Forge adopts an existing running or stopped sandbox without recreating it (reusing the same `forge-<worktree>` name), and relies on msb's start-in-place resolution instead of holding a separate keep-alive exec open.

## Large Command Output

Shell output truncation is handled by opencode's native bash tool: when output exceeds the tool limit, the full output is spilled to opencode's tool-output directory on the host (readable from loop sessions, see below). The worktree `.forge/` scratch directory is added to git exclude so forge-written files are not committed.

## Tool-Output Access

opencode spills large tool outputs to its truncation directory (`<opencode-data>/tool-output`, e.g. `~/.local/share/opencode/tool-output`) and references the saved file by absolute host path. Forge makes those overflow files readable from loop and audit sessions in two complementary ways:

- **Sandbox tools** (`bash`, `glob`, `grep`): the directory is bind-mounted **read-only at the identical sandbox path**, so the same absolute path opencode reports resolves inside the sandbox. The mount is added automatically when the directory exists; it is skipped when missing or already covered by the workspace mount.
- **Host file tools** (`read`): the directory is granted an `external_directory` allow rule in the loop/audit permission ruleset (layered after the blanket external-directory deny), so reads succeed without prompting in the unattended loop — the ruleset's blanket allow covers the `read` permission itself, but a `loop.permissions` rule that denies or asks for `read` is layered after these grants and still applies. All other external directories remain denied unless added via `loop.allowExternalDirectories`.

opencode's temp directory (`<os-tmp>/opencode` — the path opencode's bash tool advertises to agents as pre-approved scratch space) is handled the same way, but for writes: it is granted an `external_directory` allow rule for host file tools **and** bind-mounted read-write at the identical sandbox path, so scratch files an agent writes at that path resolve identically on the host and inside the sandbox. It is opencode's own directory — Forge provides no separate scratch directory, and agents can use the advertised OS temp path without issue.

## External Directory Access

`loop.allowExternalDirectories` entries are granted the same two ways, so host and container agree on what exists:

- **Host file tools** (`read`, `write`, `edit`): an `external_directory` allow rule layered after the blanket deny.
- **Sandbox tools** (`bash`, `glob`, `grep`): a **read-only** bind mount at the identical sandbox path, added automatically. Entries that do not exist on the host are skipped with a log line.

The mount is read-only because the setting exists to grant read access. To make an external directory writable from inside the sandbox, add it to `sandbox.mounts` with `"readonly": false`; explicit `sandbox.mounts` entries are resolved first, so they win for any path listed in both.

## Resource Defaults

| Option | Default | msb flag |
|---|---:|---|
| `sandbox.resources.memory` | `"8g"` | `msb create -m` |
| `sandbox.resources.cpus` | `"4"` | `msb create -c` (integer-only) |
| `sandbox.resources.dockerDisk` | `"16g"` | `msb create --mount-named <sandbox>-docker-data:/var/lib/docker:kind=disk,size=<size>` |
| `sandbox.resources.cacheDisk` | `"16g"` | `msb create --mount-named <sandbox>-cache-data:/opt/forge/.cache:kind=disk,size=<size>` |

`memory` and `cpus` are exactly what the guest gets, for its whole life. There is no autoscaling: nothing observes memory pressure, so a build needing more than `memory` is OOM-killed rather than given more. Size `memory` for the peak of the heaviest command the sandbox will run.

msb's `--max-memory`/`--max-cpus` ceilings are deliberately not exposed. They only reserve hotplug capacity that must be claimed explicitly with `msb modify --memory <size>` from the **host**; agents run inside the sandbox and cannot call `msb`, so a ceiling never rescues a failing in-sandbox build.

Resources are fixed when the sandbox is created, and forge reuses existing running or stopped sandboxes rather than recreating them. Changing these values does not resize a sandbox that already exists — remove it (`msb rm <sandbox>`) so the next run creates it with the new values, or resize it in place with `msb modify`.
