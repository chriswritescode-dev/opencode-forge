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

# HOME and every tool cache/store are pinned to fixed, world-writable paths so
# the layout is stable regardless of the executing UID.
#
# npm_config_store_dir pins pnpm's content-addressable store to a
# container-internal path. Without it, pnpm places the store on the project
# filesystem (the msb-mounted project directory), which floods the host file
# watcher and is slow over the macOS bind mount.
ENV HOME=/opt/forge \
    XDG_CACHE_HOME=/opt/forge/.cache \
    XDG_DATA_HOME=/opt/forge/.local/share \
    PNPM_HOME=/opt/forge/.local/share/pnpm \
    PATH=/opt/forge/.local/share/pnpm/bin:/opt/forge/.local/share/pnpm:$PATH \
    npm_config_cache=/opt/forge/.npm \
    npm_config_store_dir=/opt/forge/.local/share/pnpm/store
RUN mkdir -p /opt/forge/.cache /opt/forge/.local/share/pnpm/store /opt/forge/.npm \
    && chmod -R 0777 /opt/forge

# fallow CLI — dead-code analysis tool — installed globally with the same pnpm
# setup used by the rest of the sandbox image. Binaries are linked into
# /usr/local/bin so they are on PATH for arbitrary container UIDs.
#
# The trailing chmod is load-bearing: this global install runs as root and populates the
# pnpm store (store/v10/{files,index,projects}) with root-owned 0755 dirs, AFTER the earlier
# `chmod -R 0777 /opt/forge`. Because the container runs as root but agent commands run as the
# image's `agent` user via `msb exec`, that UID could not write into the root-owned store and
# `pnpm install` failed with EACCES when registering the project — which previously drove the
# agent to relocate the store onto the msb-mounted project directory (huge, slow file transfers).
# Re-asserting 0777 here, as the last build step that touches /opt/forge, keeps the store
# writable by any exec UID. Any future build step that runs pnpm as root must do the same.

# Docker Engine from Docker's official apt repository. The microVM boots a real
# kernel, so the daemon runs natively — no privileged-container or nested-
# virtualization tricks. `/var/lib/docker` is mounted as a dedicated msb block
# device and public egress is the default, so `docker run` and registry pulls
# work out of the box. The `agent` user joins the `docker` group for socket
# access without sudo; starting the daemon itself stays root-only via the
# passwordless sudo granted above. Installed before the INSTALL_BROWSER_CONTROL
# toggle so rebuilding with that flag on does not re-fetch the Docker stack.
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

ARG INSTALL_BROWSER_CONTROL=false

RUN pnpm add -g fallow@latest --global-bin-dir /usr/local/bin \
    && if [ "$INSTALL_BROWSER_CONTROL" = "true" ]; then \
      pnpm add -g @opencode-ai/browser-control@latest --global-bin-dir /usr/local/bin \
      && package_link="$(find "$(pnpm root -g)" -maxdepth 4 -type l -path '*/node_modules/@opencode-ai/browser-control' -print -quit)" \
      && package_root="$(readlink -f "$package_link")" \
      && package_modules="$(dirname "$(dirname "$package_root")")" \
      && node "$package_modules/playwright-core/cli.js" install --with-deps chromium \
      && ln -s "$package_root/extension/dist" /opt/browser-control-extension \
      && ln -s "$(node --input-type=module -e "import { chromium } from 'file://$package_modules/playwright-core/index.mjs'; console.log(chromium.executablePath())")" /usr/local/bin/chromium; \
    fi \
    && chmod -R 0777 /opt/forge

# Allow git to operate on the msb-mounted project directory regardless of owner UID.
RUN git config --system --add safe.directory '*'

# Return to the image's default user. `msb exec` (without `-u`) runs commands as
# this user, so agent commands are unprivileged by default.
USER agent
