#!/bin/sh
# Forge sandbox entrypoint.
#
# When FORGE_DIND=1 (set by the sandbox manager for Docker-in-Docker loops, which
# also launch the container as --privileged --init), this boots a nested, isolated
# Docker daemon so the loop can build and run containers for end-to-end tests. The
# nested daemon stores its data under /var/lib/docker, which the manager backs with
# an anonymous volume so overlay2 works inside the privileged container.
#
# When FORGE_DIND is unset or 0 this is a transparent passthrough: the container
# command runs unchanged and no daemon is started, so worktree-only and non-DinD
# sandbox loops pay no cost.
set -e

# Resolve the dockerd `--group` argument so the daemon socket is owned by the host GID's
# group from creation. The container runs as root, but the agent's shell commands run as the
# host UID (docker exec --user) so worktree files are host-owned; giving the socket that GID
# lets the non-root user reach dockerd without a post-start chmod (which dockerd resets,
# causing a race). When FORGE_HOST_GID is unset, commands run as root and need no group.
resolve_socket_group_arg() {
  [ -n "${FORGE_HOST_GID:-}" ] || return 0
  group_name=$(getent group "$FORGE_HOST_GID" 2>/dev/null | cut -d: -f1)
  if [ -z "$group_name" ]; then
    groupadd -g "$FORGE_HOST_GID" forgehost 2>/dev/null || true
    group_name=$(getent group "$FORGE_HOST_GID" 2>/dev/null | cut -d: -f1)
  fi
  [ -n "$group_name" ] && printf -- '--group %s' "$group_name"
}

# Guarantee the in-container exec user can reach the daemon socket. Agent shell commands run as
# the host UID:GID via `docker exec --user` (not root), so the socket must be group-accessible to
# that GID. dockerd is started with `--group` when FORGE_HOST_GID is known, but this runs only
# AFTER the daemon is confirmed ready, so it is race-free (the startup race the `--group` arg
# avoids is doing this while dockerd is still applying socket perms). It self-heals cases where the
# group did not take, and falls back to a world-accessible socket when the GID is unknown — safe
# because the container is per-loop, isolated, and already --privileged, so anyone who can exec in
# is already root-capable.
ensure_socket_access() {
  sock=/var/run/docker.sock
  [ -S "$sock" ] || return 0
  if [ -n "${FORGE_HOST_GID:-}" ] \
    && chgrp "$FORGE_HOST_GID" "$sock" 2>/dev/null \
    && chmod g+rw "$sock" 2>/dev/null; then
    echo "forge-dind: docker socket group set to GID $FORGE_HOST_GID" >&2
    return 0
  fi
  # GID unknown or chgrp failed: make the socket reachable by any exec UID/GID.
  chmod 666 "$sock" 2>/dev/null || true
  echo "forge-dind: docker socket made world-accessible (no usable FORGE_HOST_GID)" >&2
}

start_dockerd() {
  echo "forge-dind: starting nested Docker daemon" >&2
  group_arg=$(resolve_socket_group_arg)
  # Run detached; logs go to a file so failures are inspectable via docker exec.
  # shellcheck disable=SC2086
  dockerd $group_arg >/var/log/dockerd.log 2>&1 &

  # Wait for the daemon to accept API calls. Bounded so a broken daemon does not
  # hang the loop indefinitely; the loop's own tooling can still retry afterwards.
  tries=0
  until docker version >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge 60 ]; then
      echo "forge-dind: dockerd did not become ready within 60s" >&2
      tail -n 50 /var/log/dockerd.log >&2 2>/dev/null || true
      return 0
    fi
    sleep 1
  done
  echo "forge-dind: nested Docker daemon ready" >&2
  ensure_socket_access
}

if [ "${FORGE_DIND:-0}" = "1" ]; then
  start_dockerd
fi

exec "$@"
