FROM debian:bookworm-slim

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
# non-root host UID.
ENV BUN_INSTALL=/opt/bun
RUN curl -fsSL https://bun.sh/install | bash \
    && ln -sf /opt/bun/bin/bun /usr/local/bin/bun \
    && ln -sf /opt/bun/bin/bun /usr/local/bin/bunx \
    && chmod -R a+rX /opt/bun

# uv installed to a world-accessible location for the same reason as bun.
ENV UV_INSTALL_DIR=/usr/local/bin
RUN curl -fsSL https://astral.sh/uv/install.sh | bash \
    && chmod a+rx /usr/local/bin/uv /usr/local/bin/uvx

# The container runs as root (required by the nested Docker daemon), but HOME and every
# tool cache/store are pinned to fixed, world-writable paths so the layout is stable
# regardless of the executing UID.
#
# npm_config_store_dir pins pnpm's content-addressable store to a container-internal
# path. Without it, pnpm places the store on the project filesystem (the bind-mounted
# /workspace), which floods the host file watcher and is slow over the macOS bind mount.
ENV HOME=/home/forge \
    XDG_CACHE_HOME=/home/forge/.cache \
    XDG_DATA_HOME=/home/forge/.local/share \
    PNPM_HOME=/home/forge/.local/share/pnpm \
    npm_config_cache=/home/forge/.npm \
    npm_config_store_dir=/home/forge/.local/share/pnpm/store
RUN useradd -m -u 1000 forge \
    && mkdir -p /home/forge/.cache /home/forge/.local/share/pnpm/store /home/forge/.npm \
    && chmod -R 0777 /home/forge

# fallow CLI — dead-code analysis tool — installed globally with the same pnpm
# setup used by the rest of the sandbox image. Binaries are linked into
# /usr/local/bin so they are on PATH for arbitrary container UIDs.
#
# The trailing chmod is load-bearing: this global install runs as root and populates the
# pnpm store (store/v10/{files,index,projects}) with root-owned 0755 dirs, AFTER the earlier
# `chmod -R 0777 /home/forge`. Because the container runs as root but agent commands run as the
# host UID via `docker exec --user`, that UID could not write into the root-owned store and
# `pnpm install` failed with EACCES when registering the project — which previously drove the
# agent to relocate the store onto the bind-mounted /workspace (huge, slow file transfers).
# Re-asserting 0777 here, as the last build step that touches /home/forge, keeps the store
# writable by any exec UID. Any future build step that runs pnpm as root must do the same.
RUN corepack pnpm add -g fallow@2.101.0 --global-bin-dir /usr/local/bin \
    && chmod -R 0777 /home/forge

# --- Optional: in-container browser testing (Chromium + Chrome DevTools MCP) ---
# Lets loops drive a browser inside the sandbox against dev servers that also run
# inside the sandbox (shared network namespace, plain localhost) with zero host
# exposure. Opt-in per project via `loop.worktreeOpencodeConfig`; see
# docs/sandbox.md "Browser testing". Delete this whole block to build a slimmer
# image without browser support.
#
# Debian's chromium package is used because Google Chrome ships no linux/arm64
# build (Apple Silicon hosts run linux/arm64 containers). The trailing chmod
# re-asserts store permissions after a root pnpm install — see the fallow note
# above; it applies to every root pnpm step.
RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
RUN corepack pnpm add -g chrome-devtools-mcp@1.5.0 --global-bin-dir /usr/local/bin \
    && chmod -R 0777 /home/forge
# --- End optional browser testing block ---

# Docker Engine (daemon + CLI + buildx + compose) from Docker's official apt
# repository. This enables Docker-in-Docker: when the container is launched with
# FORGE_DIND=1 (privileged), the entrypoint starts a nested, isolated dockerd so
# loops can build and run containers for end-to-end tests. iptables is required
# by dockerd for container networking; debian bookworm uses the nft backend.
RUN install -m0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        docker-ce \
        docker-ce-cli \
        containerd.io \
        docker-buildx-plugin \
        docker-compose-plugin \
        iptables \
    && rm -rf /var/lib/apt/lists/*

# Allow git to operate on the bind-mounted workspace regardless of owner UID.
RUN git config --system --add safe.directory '*'

# Entrypoint conditionally boots the nested Docker daemon before handing off to
# the container command. When FORGE_DIND is unset/0 it is a transparent passthrough,
# so non-DinD loops pay no runtime cost.
COPY dind-entrypoint.sh /usr/local/bin/dind-entrypoint.sh
RUN chmod 0755 /usr/local/bin/dind-entrypoint.sh

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/dind-entrypoint.sh"]
CMD ["sleep", "infinity"]
