#!/usr/bin/env bash
# Mirror the latest GHCR images to the local Zot registry at $ZOT_REGISTRY.
# Run this from a machine that has network access to the NAS (i.e. your laptop
# on Tailscale), NOT from the GHA runner (which can't reach 100.64.x.x).
#
# After this, the NAS can pull the same images from Zot if GHCR is unreachable.
set -euo pipefail

GHCR_REGISTRY="${GHCR_REGISTRY:-ghcr.io}"
GHCR_OWNER="${GHCR_OWNER:-entin-hun}"
ZOT_REGISTRY="${ZOT_REGISTRY:-100.64.152.116:5000}"
BACKEND_IMAGE="${BACKEND_IMAGE:-programap-backend}"
FRONTEND_IMAGE="${FRONTEND_IMAGE:-programap-frontend}"
TAG="${TAG:-latest}"

for img in "$BACKEND_IMAGE" "$FRONTEND_IMAGE"; do
    src="$GHCR_REGISTRY/$GHCR_OWNER/$img:$TAG"
    dst="$ZOT_REGISTRY/$img:$TAG"
    echo ">>> $src -> $dst"
    docker pull "$src"
    docker tag "$src" "$dst"
    docker push "$dst"
done

echo ""
echo "Zot now has:"
curl -sS "http://$ZOT_REGISTRY/v2/_catalog" | python3 -m json.tool
