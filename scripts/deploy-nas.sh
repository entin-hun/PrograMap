#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DOCKER_CONTEXT_NAME="${DOCKER_CONTEXT_NAME:-asustor-nas}"
export DOCKER_CONTEXT="$DOCKER_CONTEXT_NAME"
export REMOTE_BACKEND_ATTACH_DIR="${REMOTE_BACKEND_ATTACH_DIR:-/volume1/home/balint/trail-planner/backend}"

echo "Deploying trail-planner from $ROOT_DIR"
echo "Using Docker context: $DOCKER_CONTEXT"
echo "Using secret mount directory: $REMOTE_BACKEND_ATTACH_DIR"

docker-compose -f docker-compose.yml up -d --build

for attempt in $(seq 1 30); do
    if ssh -p "${NAS_PORT:-8372}" "${NAS_USER:-balint}@${NAS_HOST:-100.64.152.116}" "curl --fail --silent http://127.0.0.1:8269/api/config >/dev/null"; then
        echo "Backend is healthy"
        exit 0
    fi
    sleep 2
done

echo "Backend health check failed" >&2
exit 1
