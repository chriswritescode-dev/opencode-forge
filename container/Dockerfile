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

# The container is launched with `--user <hostUID>:<hostGID>` (forge's
# runAsHostUser default). That UID has no /etc/passwd entry, so HOME and every
# tool cache/store must resolve to fixed, world-writable paths.
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

# Allow git to operate on the bind-mounted workspace regardless of owner UID.
RUN git config --system --add safe.directory '*'

WORKDIR /workspace
CMD ["sleep", "infinity"]
