#!/usr/bin/env bash
# Stop the Docker Gateway.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(cd "${SCRIPT_DIR}/.." && pwd)"

docker compose down
echo "Gateway stopped."
