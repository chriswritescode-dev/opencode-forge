# Forge sandbox image, built on a plain Ubuntu base for the microsandbox (msb)
# runtime. msb boots this image as a microVM with its own kernel and runs its
# own `agentd` as PID 1, so the image's ENTRYPOINT/CMD are never executed.
# Docker Engine therefore runs natively inside the microVM; since nothing runs
# an entrypoint at boot, `forge-dockerd-start` (installed below) is the way to
# bring the daemon up.
FROM ubuntu:24.04

# Create the runtime user explicitly: the plain Ubuntu base ships a default
# `ubuntu` user holding uid/gid 1000, which is removed so the `agent` user
# (uid/gid 1000, home /home/agent) replaces it, matching the built-in user the
# Docker template used to provide. System-level installs below run as root; the
# final USER directive returns to `agent` so `msb exec` commands run
# unprivileged. The sandbox manager does not pass `-u` to `msb exec`.
USER root
RUN userdel -r ubuntu 2>/dev/null || true; groupdel ubuntu 2>/dev/null || true; \
    useradd --create-home --shell /bin/bash --uid 1000 --user-group agent

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    git \
    jq \
    python3 \
    ripgrep \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Guarantee passwordless root elevation for the `agent` user so system-wide
# package installs (apt, gem, npm -g, pip) work inside sandbox loops. `msb exec`
# commands stay unprivileged as `agent`; installs use an explicit `sudo` prefix.
RUN apt-get update && apt-get install -y --no-install-recommends sudo \
    && echo 'agent ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/forge-agent \
    && chmod 0440 /etc/sudoers.d/forge-agent \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_current.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# pnpm installed globally at build time so the container never downloads a package
# manager at runtime. Node stopped shipping corepack in v25, so npm is the install
# path; the resulting /usr/local tree is readable by an arbitrary host UID.
RUN npm install -g pnpm@latest

# bun installed to a world-accessible location. The default installer targets
# /root/.bun, which is unreadable (mode 0700) when the container runs as a
# non-root user.
ENV BUN_INSTALL=/opt/bun
RUN curl -fsSL https://bun.sh/install | bash \
    && ln -sf /opt/bun/bin/bun /usr/local/bin/bun \
    && ln -sf /opt/bun/bin/bun /usr/local/bin/bunx \
    && chmod -R a+rX /opt/bun

# uv installed to a world-accessible location for the same reason as bun.
ENV UV_INSTALL_DIR=/usr/local/bin
RUN curl -fsSL https://astral.sh/uv/install.sh | bash \
    && chmod a+rx /usr/local/bin/uv /usr/local/bin/uvx

# HOME and every tool cache/store are pinned to fixed paths so the layout is
# stable regardless of the executing UID. All of the caches below resolve under
# /opt/forge/.cache, which Forge mounts as a dedicated sparse block device at
# create time (forge-<name>-cache-data), so unbounded package caches never fill
# the small root filesystem and nothing written to that path at build time
# survives to runtime. forge-cache-prune wipes its cache subtrees while
# preserving the installed toolchains and binary dirs (rustup, uv-python,
# uv-tools, uv-bin, cargo/bin, go/bin).
#
# Both store-dir variables pin pnpm's content-addressable store to a
# container-internal path: pnpm 11 reads PNPM_CONFIG_STORE_DIR while pnpm 10
# ignores it and reads npm_config_store_dir instead. Projects pinned to pnpm 10
# would otherwise place the store on the project filesystem (the msb-mounted
# project directory, as a worktree-local .pnpm-store), which floods the host
# file watcher and is slow over the macOS bind mount. Because the store sits on
# a different filesystem than the mounted project, pnpm copies packages into
# node_modules instead of hard-linking, exactly as it already did against the
# virtiofs project mount.
ENV HOME=/opt/forge \
    XDG_CACHE_HOME=/opt/forge/.cache \
    XDG_DATA_HOME=/opt/forge/.local/share \
    PNPM_HOME=/opt/forge/.local/share/pnpm \
    PATH=/opt/forge/.cache/uv-bin:/opt/forge/.local/share/pnpm/bin:/opt/forge/.local/share/pnpm:$PATH \
    npm_config_cache=/opt/forge/.cache/npm \
    npm_config_store_dir=/opt/forge/.cache/pnpm/store \
    PNPM_CONFIG_STORE_DIR=/opt/forge/.cache/pnpm/store \
    UV_PYTHON_INSTALL_DIR=/opt/forge/.cache/uv-python \
    UV_TOOL_DIR=/opt/forge/.cache/uv-tools \
    UV_TOOL_BIN_DIR=/opt/forge/.cache/uv-bin \
    CARGO_HOME=/opt/forge/.cache/cargo \
    RUSTUP_HOME=/opt/forge/.cache/rustup \
    GOPATH=/opt/forge/.cache/go
RUN mkdir -p /opt/forge/.cache /opt/forge/.local/share/pnpm \
    && chmod -R 0777 /opt/forge

# fallow CLI — dead-code analysis tool — installed globally with the same pnpm
# setup used by the rest of the sandbox image. Binaries are linked into
# /usr/local/bin so they are on PATH for arbitrary container UIDs.
#
# --store-dir is load-bearing and must NOT be dropped to inherit the ENV store.
# pnpm does not copy a globally installed package into PNPM_HOME: the global
# node_modules entry is a symlink chain into the store's links/ directory. A
# global installed against the cache-disk store therefore resolves to a dangling
# symlink at runtime, because the dedicated cache disk is mounted over that path
# and hides everything the build wrote there — `fallow --version` then dies with
# "Cannot find module". Pinning the build-time store under /opt/forge/.local,
# which the image actually ships and no mount shadows, keeps every global CLI
# working; the ENV store keeps agent installs on the cache disk.
#
# The install then deletes whatever it cached under /opt/forge/.cache, since that
# path is shadowed at runtime and those bytes would be unreachable weight on the
# small root filesystem. The trailing chmod re-asserts 0777 on the tree the image
# ships — PNPM_HOME and XDG_DATA_HOME under /opt/forge/.local — keeping it
# writable by any exec UID. The cache tree's runtime permissions are owned by the
# sandbox manager, which chowns and chmods the mounted cache disk at create time;
# no build step establishes them.
RUN pnpm add -g fallow@latest --global-bin-dir /usr/local/bin --store-dir /opt/forge/.local/share/pnpm/store \
    && rm -rf /opt/forge/.cache/* /opt/forge/.cache/.[!.]* /opt/forge/.cache/..?* \
    && chmod -R 0777 /opt/forge

# Obscura (https://github.com/h4ckf0r0day/obscura) — Rust headless browser
# engine with embedded V8 — replaces the former Playwright Chromium install.
# The release tarball ships static `obscura` and `obscura-worker` binaries that
# need no system libraries beyond the base image's glibc, so nothing is apt-
# installed here. The archive layout is flat, so `tar xz` must extract straight
# into /usr/local/bin; `obscura-worker` has to sit next to `obscura` for
# parallel scraping. The architecture mapping matches dpkg naming to the
# upstream release assets (amd64 -> x86_64, arm64 -> aarch64).
RUN obscura_arch="$(case "$(dpkg --print-architecture)" in \
        amd64) echo x86_64 ;; \
        arm64) echo aarch64 ;; \
        *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac)" \
    && curl -fsSL "https://github.com/h4ckf0r0day/obscura/releases/latest/download/obscura-${obscura_arch}-linux.tar.gz" \
        | tar xz -C /usr/local/bin \
    && chmod 0755 /usr/local/bin/obscura /usr/local/bin/obscura-worker

# Docker Engine from Docker's official apt repository. The microVM boots a real
# kernel, so the daemon runs natively — no privileged-container or nested-
# virtualization tricks. `/var/lib/docker` is mounted as a dedicated msb block
# device and public egress is the default, so `docker run` and registry pulls
# work out of the box. The `agent` user joins the `docker` group for socket
# access without sudo; starting the daemon itself stays root-only via the
# passwordless sudo granted above.
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
    && usermod -aG docker agent \
    && rm -rf /var/lib/apt/lists/*

# msb ignores ENTRYPOINT/CMD, so nothing starts dockerd at boot. This idempotent
# helper is the single way to ensure the daemon is running inside a sandbox: it
# starts dockerd detached (setsid, root-owned, log at /var/log/dockerd.log, stdin
# from /dev/null) and waits up to 60s for `docker info` to succeed, then exits
# non-zero with the log tail if the daemon never becomes ready. An flock
# serializes concurrent invocations so two simultaneous calls cannot start two
# daemons. It re-execs itself under the passwordless sudo rule above when called
# unprivileged, so `agent` can invoke it directly.
RUN cat > /usr/local/bin/forge-dockerd-start <<'EOF' && chmod 0755 /usr/local/bin/forge-dockerd-start
#!/bin/sh
set -u

lock=/var/run/forge-dockerd.lock
log=/var/log/dockerd.log
ready_timeout=60

# Already serving: nothing to do. `agent` is in the docker group, so this probe
# needs no elevation.
docker info >/dev/null 2>&1 && exit 0

# The daemon, its lock and its log all require root, so re-exec once under the
# passwordless sudo rule. This keeps the command callable as plain
# `forge-dockerd-start` from an unprivileged sandbox session.
if [ "$(id -u)" -ne 0 ]; then
    exec sudo -n "$0" "$@"
fi

# Serialize concurrent starts so only one daemon is ever launched.
exec 9>"$lock"
flock 9 || exit 1

# Someone else may have brought the daemon up while we waited for the lock.
docker info >/dev/null 2>&1 && exit 0

# A daemon is already starting but not yet answering: wait for it below.
if [ -f /var/run/docker.pid ] && kill -0 "$(cat /var/run/docker.pid)" 2>/dev/null; then
    :
else
    # Launch detached. `9>&-` closes the inherited lock fd in the daemon so the
    # flock is released when this script exits instead of being held open for
    # the daemon's lifetime.
    setsid dockerd >"$log" 2>&1 </dev/null 9>&- &
fi

elapsed=0
while [ "$elapsed" -lt "$ready_timeout" ]; do
    if docker info >/dev/null 2>&1; then
        exit 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
done

echo "dockerd did not become ready within ${ready_timeout}s; tail of $log:" >&2
tail -n 20 "$log" 2>/dev/null >&2
exit 1
EOF

RUN cat > /usr/local/bin/forge-cache-prune <<'EOF' && chmod 0755 /usr/local/bin/forge-cache-prune
#!/bin/sh
set -u
cache="${XDG_CACHE_HOME:-/opt/forge/.cache}"

wipe() {
    rm -rf "$1" 2>/dev/null || sudo -n rm -rf "$1" || true
}

for entry in "$cache"/* "$cache"/.[!.]* "$cache"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    case "$entry" in
        "$cache"/rustup|"$cache"/uv-python|"$cache"/uv-tools|"$cache"/uv-bin) ;;
        "$cache"/cargo)
            wipe "$cache/cargo/registry"
            wipe "$cache/cargo/git"
            ;;
        "$cache"/go) wipe "$cache/go/pkg/mod" ;;
        *) wipe "$entry" ;;
    esac
done

sudo -n apt-get clean
sudo -n /usr/sbin/fstrim -v "$cache" 2>/dev/null || true
EOF

# Allow git to operate on the msb-mounted project directory regardless of owner UID.
RUN git config --system --add safe.directory '*'

# Return to the image's default user. `msb exec` (without `-u`) runs commands as
# this user, so agent commands are unprivileged by default.
USER agent
