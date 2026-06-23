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

start_dockerd() {
  echo "forge-dind: starting nested Docker daemon" >&2
  # Run detached; logs go to a file so failures are inspectable via docker exec.
  dockerd >/var/log/dockerd.log 2>&1 &

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
}

if [ "${FORGE_DIND:-0}" = "1" ]; then
  start_dockerd
fi

exec "$@"
