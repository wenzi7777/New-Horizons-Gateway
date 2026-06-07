#!/usr/bin/env bash
# Start the Gateway in Docker. Always rebuilds the image so code changes
# are picked up automatically.
#
# On macOS / Windows, Docker bridge networking does not preserve the
# device UDP source IP. Use scripts/start.sh for local development.
# On Linux, add "network_mode: host" to docker-compose.yml for full
# host-network access and correct device IP detection.
#
# Usage: ./start_docker.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${APP_DIR}"

docker compose \
  -f docker-compose.yml \
  -f docker-compose.container-discovery.yml \
  up -d --build

echo "Gateway started (Docker)"
echo "WebUI   http://127.0.0.1:${NEWHORIZONS_GATEWAY_WEB_PORT:-5052}"
