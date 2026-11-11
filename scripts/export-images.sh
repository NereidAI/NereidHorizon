#!/usr/bin/env bash
#
# Copyright (C) 2026 YIQISOFT
#
# SPDX-License-Identifier: Apache-2.0
#
# Export NereidHorizon Docker images for offline / air-gapped deployment.
# Run this on a machine with internet access and Docker, then transfer
# the resulting tarball to the production host and run `load-images.sh`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${NEREIDHORIZON_ENV_FILE:-${ENV_FILE:-${REPO_ROOT}/../.deployment/deploy-values/nereidhorizon/backend.env}}"

# Treaty §19.2: the tarball carries the same three tags as GHCR (VERSION,
# VERSION-<utc-timestamp>, VERSION-<git-short-sha>); no latest tag. BUILD_TS
# and GIT_SHA are passed into make so the saved tags match the built images
# exactly, and docker save finds them in the local daemon. There is no
# VERSION file: an explicit argument wins, otherwise the tag is derived from
# the exact git tag (v0.0.1 -> 0.0.1) or falls back to the 0.0.0-dev channel.
IMAGE_TAG="${1:-$(ref=$(git -C "${REPO_ROOT}" describe --tags --exact-match 2>/dev/null) && echo "${ref#v}" || echo 0.0.0-dev)}"
OUT_FILE="${2:-nereid-images.tar}"
GIT_SHA="$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
BUILD_TS="$(date -u +%Y%m%d-%H%M)"

IMAGES=(
  "ghcr.io/nereidai/nereidhorizon-backend:${IMAGE_TAG}"
  "ghcr.io/nereidai/nereidhorizon-backend:${IMAGE_TAG}-${BUILD_TS}"
  "ghcr.io/nereidai/nereidhorizon-backend:${IMAGE_TAG}-${GIT_SHA}"
  "ghcr.io/nereidai/nereidhorizon-frontend:${IMAGE_TAG}"
  "ghcr.io/nereidai/nereidhorizon-frontend:${IMAGE_TAG}-${BUILD_TS}"
  "ghcr.io/nereidai/nereidhorizon-frontend:${IMAGE_TAG}-${GIT_SHA}"
  "postgres:16-alpine"
)

echo ">> Building images (three tags each, no push)..."
make -C "${REPO_ROOT}" image VERSION="${IMAGE_TAG}" BUILD_TS="${BUILD_TS}" GIT_SHA="${GIT_SHA}"

echo ">> Saving images to ${OUT_FILE} ..."
docker save -o "${OUT_FILE}" "${IMAGES[@]}"

echo ">> Done. Transfer ${OUT_FILE} to the production host and run:"
echo "   docker load -i ${OUT_FILE}"
echo "   docker compose --env-file \"${ENV_FILE}\" -f \"${REPO_ROOT}/docker-compose.yaml\" up -d"
