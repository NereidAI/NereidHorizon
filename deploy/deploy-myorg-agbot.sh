#!/bin/bash
# Copyright (C) 2026 YIQISOFT
# SPDX-License-Identifier: Apache-2.0
#
# Deploy the myorg/myagbot container against a management-hub Exchange.
#
# Usage:
#   1. Register the agbot token in the Exchange first (ROOT_AUTH is the
#      hub-level credentials in user:password form):
#      curl -s -u "$ROOT_AUTH" -X PUT \
#        -H "Content-Type: application/json" \
#        -d '{"token":"mytoken"}' \
#        "$EXCHANGE_URL/orgs/myorg/agbots/myagbot"
#   2. Export AGBOT_TOKEN (and ROOT_AUTH / EXCHANGE_URL if they differ from
#      the defaults), then run: sudo bash deploy-myorg-agbot.sh
set -e

EXCHANGE_URL="${EXCHANGE_URL:-http://localhost:3090/v1}"
ROOT_AUTH="${ROOT_AUTH:-}"
AGBOT_TOKEN="${AGBOT_TOKEN:-}"

if [[ -z "$ROOT_AUTH" ]]; then
  echo "ERROR: ROOT_AUTH must be supplied as user:password via the environment." >&2
  exit 1
fi

# ---- 1. Register the Exchange token when one is provided ----
if [[ -n "$AGBOT_TOKEN" ]]; then
  echo ">>> Registering myorg/myagbot token ..."
  curl -s -u "$ROOT_AUTH" -X PUT \
    -H "Content-Type: application/json" \
    -d "{\"token\":\"$AGBOT_TOKEN\"}" \
    "$EXCHANGE_URL/orgs/myorg/agbots/myagbot"
  echo ""
fi

# ---- 2. Generate the configuration file ----
echo ">>> Writing /etc/horizon/myorg-agbot.json ..."
if [[ -z "$AGBOT_TOKEN" ]]; then
  echo "WARNING: AGBOT_TOKEN is not set; edit ExchangeToken in /etc/horizon/myorg-agbot.json manually."
fi

cat > /etc/horizon/myorg-agbot.json << EOF
{
    "AgreementBot": {
        "DBPath": "",
        "Postgresql": {
            "Host": "postgres",
            "Port": "5432",
            "User": "admin",
            "Password": "",
            "DBName": "exchange",
            "SSLMode": "disable",
            "MaxOpenConnections": 20
        },
        "TxLostDelayTolerationSeconds": 120,
        "AgreementWorkers": 5,
        "ProtocolTimeoutS": 120,
        "AgreementTimeoutS": 360,
        "NoDataIntervalS": 300,
        "ActiveAgreementsURL": "",
        "ActiveAgreementsUser": "",
        "ActiveAgreementsPW": "",
        "PolicyPath": "/home/agbotuser/policy.d",
        "NewContractIntervalS": 5,
        "ProcessGovernanceIntervalS": 5,
        "IgnoreContractWithAttribs": "ethereum_account",
        "ExchangeURL": "http://exchange-api:8080/v1",
        "ExchangeId": "myorg/myagbot",
        "ExchangeToken": "${AGBOT_TOKEN}",
        "ExchangeHeartbeat": 5,
        "ExchangeMessageTTL": 1800,
        "ActiveDeviceTimeoutS": 180,
        "DefaultWorkloadPW": "",
        "MessageKeyPath": "msgKey",
        "APIListen": "0.0.0.0:8080",
        "PurgeArchivedAgreementHours": 1,
        "CheckUpdatedPolicyS": 7,
        "CSSURL": "http://css-api:8080",
        "CSSSSLCert": "",
        "SecureAPIListenHost": "0.0.0.0",
        "SecureAPIListenPort": "8083",
        "SecureAPIServerKey": "",
        "SecureAPIServerCert": "",
        "AgreementBatchSize": 300,
        "RetryLookBackWindow": 3600,
        "MMSGarbageCollectionInterval": 20,
        "Vault": {
            "VaultURL": "http://bao:8200"
        }
    },
    "ArchSynonyms": {
        "x86_64": "amd64",
        "armhf": "arm",
        "aarch64": "arm64"
    }
}
EOF

echo ">>> Configuration written to /etc/horizon/myorg-agbot.json"

# ---- 3. Start the container ----
echo ">>> Starting the myorg-agbot container ..."
docker rm -f myorg-agbot 2>/dev/null || true
docker run -d --name myorg-agbot --restart always \
  --network hzn_horizonnet \
  -p 0.0.0.0:3112:8080 \
  -p 0.0.0.0:3113:8083 \
  -v /etc/horizon/myorg-agbot.json:/etc/horizon/anax.json.tmpl:ro \
  -v /etc/horizon/keys:/home/agbotuser/keys:ro \
  -v myorg-agbot-msgkey:/var/horizon/msgKey \
  -e ANAX_LOG_LEVEL=3 \
  ghcr.io/open-horizon/amd64_agbot:latest

echo ">>> Status:"
sleep 3
docker ps --filter name=myorg-agbot --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
