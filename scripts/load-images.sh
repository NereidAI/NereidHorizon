#!/usr/bin/env bash
#
# Copyright (C) 2026 YIQISOFT
#
# SPDX-License-Identifier: Apache-2.0
#
# Load NereidHorizon Docker images previously exported by export-images.sh.
# For offline / air-gapped production hosts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${NEREIDHORIZON_ENV_FILE:-${ENV_FILE:-${REPO_ROOT}/../.deployment/deploy-values/nereidhorizon/backend.env}}"

IN_FILE="${1:-nereid-images.tar}"

if [ ! -f "${IN_FILE}" ]; then
  echo "ERROR: ${IN_FILE} not found" >&2
  exit 1
fi

echo ">> Loading images from ${IN_FILE} ..."
docker load -i "${IN_FILE}"

echo ">> Done. Start the stack with:"
echo "   docker compose --env-file \"${ENV_FILE}\" -f \"${REPO_ROOT}/docker-compose.yaml\" up -d"
