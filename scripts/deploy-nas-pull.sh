#!/usr/bin/env bash
# Pull-based deploy to the NAS: tries GHCR first, falls back to Zot.
#
# The `nas` docker context (set up as
#   docker context create nas --docker "host=ssh://balint@100.64.152.116:8372"
# ) gives this machine a Docker daemon on the NAS while still reading the
# compose file locally. Volume bind mounts are resolved by the NAS daemon,
# so we set REMOTE_BACKEND_ATTACH_DIR to the NAS-side path.
#
# Pre-requisites:
#   - docker context `nas` exists and works (`docker --context nas version`)
#   - the NAS has a copy of the repo at $STACK_DIR (or this is run from a
#     checkout that's already there)
#
# Notes:
#   - This is the new path. The older build-on-NAS approach is in
#     scripts/deploy-nas.sh and is kept as a backup.
set -euo pipefail

DOCKER_CONTEXT_NAME="${DOCKER_CONTEXT_NAME:-nas}"
BACKEND_IMAGE="${BACKEND_IMAGE:-programap-backend}"
FRONTEND_IMAGE="${FRONTEND_IMAGE:-programap-frontend}"
TAG="${TAG:-latest}"
GHCR_BASE="${GHCR_BASE:-ghcr.io/entin-hun}"
ZOT_BASE="${ZOT_BASE:-100.64.152.116:5000}"
REMOTE_BACKEND_ATTACH_DIR="${REMOTE_BACKEND_ATTACH_DIR:-/volume1/home/balint/trail-planner/backend}"

export DOCKER_CONTEXT="$DOCKER_CONTEXT_NAME"
export REMOTE_BACKEND_ATTACH_DIR
export BACKEND_IMAGE FRONTEND_IMAGE TAG GHCR_BASE ZOT_BASE

echo "=== Deploying to docker context: $DOCKER_CONTEXT_NAME ==="
docker --context "$DOCKER_CONTEXT_NAME" version --format '{{.Server.Version}}' \
    | xargs -I{} echo "  NAS Docker server: {}"

# Try pulling from a given registry base.
pull_from() {
    local base="$1"
    local backend_src="$base/$BACKEND_IMAGE:$TAG"
    local frontend_src="$base/$FRONTEND_IMAGE:$TAG"
    echo ">>> Pulling $backend_src and $frontend_src"
    docker --context "$DOCKER_CONTEXT_NAME" pull "$backend_src"
    docker --context "$DOCKER_CONTEXT_NAME" pull "$frontend_src"
}

# Pick the first registry that works. GHCR is the public primary;
# Zot is the local mirror for when GHCR is unreachable from the NAS.
if pull_from "$GHCR_BASE" 2>/dev/null; then
    echo "Pulled from GHCR."
elif pull_from "$ZOT_BASE" 2>/dev/null; then
    echo "Pulled from Zot fallback."
else
    echo "Both registries failed. Mirror GHCR to Zot with scripts/mirror-to-zot.sh first?" >&2
    exit 1
fi

# Recreate the services so they pick up the freshly-pulled images.
# `up -d` will only recreate containers whose image changed, so this is safe.
echo ">>> docker compose up -d"
docker --context "$DOCKER_CONTEXT_NAME" compose up -d

# Health check: poll the backend /api/config on the host port mapped to 8223.
echo ">>> Health check (backend /api/config on :8269)..."
for attempt in $(seq 1 30); do
    if docker --context "$DOCKER_CONTEXT_NAME" run --rm --network host \
        curlimages/curl:8.10.1 \
        curl --fail --silent http://127.0.0.1:8269/api/config >/dev/null; then
        echo "Backend is healthy"
        exit 0
    fi
    sleep 2
done

echo "Backend health check failed" >&2
exit 1
