# Forge sandbox image, derived from Docker's official sbx shell template.
# Deriving (rather than building from scratch) preserves the labels, default
# `agent` user, entrypoint and command contract that `sbx` expects from a
# -t/--template image; the shell-docker flavour already ships a working
# in-sandbox Docker Engine, so no Docker installation is needed here.
FROM docker.io/docker/sandbox-templates:shell-docker

# The base template runs as a non-root `agent` user (with sudo). System-level
# package installs below run as root; the final USER directive returns to the
# agent user so `sbx exec` commands run unprivileged, matching the template
# contract. The sandbox manager does not pass `-u` to `sbx exec`.
USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    jq \
    python3 \
    ripgrep \
    unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# pnpm via corepack, pinned and pre-activated into a world-readable/writable
# cache so the container can run as an arbitrary host UID without downloading
# pnpm at runtime.
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable \
    && corepack prepare pnpm@10.28.1 --activate \
    && chmod -R 0777 /opt/corepack

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
# filesystem (the sbx-mounted project directory), which floods the host file
# watcher and is slow over the macOS bind mount.
ENV HOME=/opt/forge \
    XDG_CACHE_HOME=/opt/forge/.cache \
    XDG_DATA_HOME=/opt/forge/.local/share \
    PNPM_HOME=/opt/forge/.local/share/pnpm \
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
# template's `agent` user via `sbx exec`, that UID could not write into the root-owned store and
# `pnpm install` failed with EACCES when registering the project — which previously drove the
# agent to relocate the store onto the sbx-mounted project directory (huge, slow file transfers).
# Re-asserting 0777 here, as the last build step that touches /opt/forge, keeps the store
# writable by any exec UID. Any future build step that runs pnpm as root must do the same.
RUN corepack pnpm add -g fallow@2.101.0 --global-bin-dir /usr/local/bin \
    && chmod -R 0777 /opt/forge

# Allow git to operate on the sbx-mounted project directory regardless of owner UID.
RUN git config --system --add safe.directory '*'

# Return to the template's default user. `sbx exec` (without `-u`) runs commands
# as this user, so agent commands are unprivileged by default.
USER agent
