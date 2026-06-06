#!/usr/bin/env bash
# Stop the host-mode Gateway.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PID_FILE="${APP_DIR}/.run/gateway.pid"

if [[ ! -f "${PID_FILE}" ]]; then
  echo "Gateway is not running (no PID file)."
  exit 0
fi

PID="$(cat "${PID_FILE}" 2>/dev/null || true)"
if [[ -n "${PID}" ]] && kill -0 "${PID}" 2>/dev/null; then
  kill "${PID}"
  echo "Gateway stopped (PID ${PID})."
else
  echo "Gateway is not running."
fi
rm -f "${PID_FILE}"
