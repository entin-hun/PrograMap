#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export REMOTE_BACKEND_ATTACH_DIR="${REMOTE_BACKEND_ATTACH_DIR:-$ROOT_DIR/backend}"

echo "Deploying trail-planner from $ROOT_DIR"
echo "Using secret mount directory: $REMOTE_BACKEND_ATTACH_DIR"

docker-compose -f docker-compose.yml up -d --build

for attempt in $(seq 1 30); do
    if curl --fail --silent http://127.0.0.1:8269/api/config >/dev/null; then
        echo "Backend is healthy"
        exit 0
    fi
    sleep 2
done

echo "Backend health check failed" >&2
exit 1
