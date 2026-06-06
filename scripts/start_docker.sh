#!/usr/bin/env bash
# Start the Gateway in Docker.
#
# On macOS / Windows, Docker bridge networking does not preserve the
# device UDP source IP. Use scripts/start.sh for local development.
# On Linux, add "network_mode: host" to docker-compose.yml for full
# host-network access and correct device IP detection.
#
# Usage: ./start_docker.sh [--build]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUILD=0

for arg in "$@"; do
  case "${arg}" in
    --build) BUILD=1 ;;
    *) echo "Usage: $0 [--build]" >&2; exit 2 ;;
  esac
done

cd "${APP_DIR}"

ARGS=(
  -f docker-compose.yml
  -f docker-compose.container-discovery.yml
  up -d
)
[[ "${BUILD}" -eq 1 ]] && ARGS+=(--build)

docker compose "${ARGS[@]}"

echo "Gateway started (Docker)"
echo "WebUI   http://127.0.0.1:${NEWHORIZONS_GATEWAY_WEB_PORT:-5052}"
