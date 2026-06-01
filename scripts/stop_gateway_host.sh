#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PID_FILE="${APP_DIR}/.run/host_gateway.pid"
SESSION_NAME="${NEWHORIZONS_GATEWAY_SCREEN_SESSION:-newhorizons-gateway-host}"

if [[ ! -f "${PID_FILE}" ]]; then
  screen -S "${SESSION_NAME}" -X quit >/dev/null 2>&1 || true
  echo "Host Gateway is not running."
  exit 0
fi

PID="$(cat "${PID_FILE}" || true)"
if [[ "${PID}" == screen:* ]]; then
  TARGET_SESSION="${PID#screen:}"
  screen -S "${TARGET_SESSION}" -X quit >/dev/null 2>&1 || true
  echo "Stopped Host Gateway session ${TARGET_SESSION}."
elif [[ -n "${PID}" ]] && kill -0 "${PID}" >/dev/null 2>&1; then
  kill "${PID}" >/dev/null 2>&1 || true
  echo "Stopped Host Gateway PID ${PID}."
else
  echo "Host Gateway PID is not active."
fi
rm -f "${PID_FILE}"
