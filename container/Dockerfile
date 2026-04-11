FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    python3 \
    python3-venv \
    procps \
    sudo \
    ca-certificates \
    unzip \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm

RUN useradd -m -s /bin/bash -u 1001 devuser && \
    echo "devuser ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

RUN ARCH="$(uname -m)" && \
    curl -LsSf "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-${ARCH}-unknown-linux-gnu.tar.gz" | tar xz && \
    mv "ripgrep-14.1.1-${ARCH}-unknown-linux-gnu/rg" /usr/local/bin/ && \
    rm -rf "ripgrep-14.1.1-${ARCH}-unknown-linux-gnu"

USER devuser

ENV PNPM_HOME="/home/devuser/.local/share/pnpm"
ENV npm_config_store_dir="/home/devuser/.local/share/pnpm/store"
ENV PATH="${PNPM_HOME}:${PATH}"

RUN mkdir -p "$PNPM_HOME" && \
    PATH="$PNPM_HOME:$PATH" pnpm add -g typescript

RUN curl -LsSf https://astral.sh/uv/install.sh | sh
RUN curl -fsSL https://bun.sh/install | bash

ENV PATH="/home/devuser/.local/bin:/home/devuser/.bun/bin:/home/devuser/.cargo/bin:${PATH}"

WORKDIR /workspace
CMD ["sleep", "infinity"]
