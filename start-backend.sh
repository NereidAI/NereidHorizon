#!/usr/bin/env bash
# Copyright (C) 2026 YIQISOFT
# SPDX-License-Identifier: Apache-2.0
# Start the local BFF with centralized deployment inputs and private logs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}"
DEPLOY_VALUES_DIR="${NEREIDHORIZON_DEPLOY_VALUES_DIR:-${DEPLOY_VALUES_DIR:-${REPO_ROOT}/../.deployment/deploy-values/nereidhorizon}}"
ENV_FILE="${NEREIDHORIZON_ENV_FILE:-${ENV_FILE:-${DEPLOY_VALUES_DIR}/backend.env}}"
LOG_DIR="${NEREIDHORIZON_LOG_DIR:-${LOG_DIR:-${REPO_ROOT}/../.deployment/deploy-logs/nereidhorizon}}"
SESSION_KEY_FILE="${NEREIDHORIZON_SESSION_KEY_FILE:-${SESSION_KEY_FILE:-${DEPLOY_VALUES_DIR}/state/session.key}}"
export ENV_FILE LOG_DIR SESSION_KEY_FILE

install -d -m 700 "${LOG_DIR}" "$(dirname "${SESSION_KEY_FILE}")"
touch "${LOG_DIR}/backend.log"
chmod 600 "${LOG_DIR}/backend.log"

pkill -f "node server/index.cjs" 2>/dev/null || true
sleep 1
cd "${REPO_ROOT}"
nohup node server/index.cjs >> "${LOG_DIR}/backend.log" 2>&1 &
disown
sleep 2
curl -fsS http://localhost:3001/api/health
