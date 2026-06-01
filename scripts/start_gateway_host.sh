#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
RUN_DIR="${APP_DIR}/.run"
PID_FILE="${RUN_DIR}/host_gateway.pid"
LOG_FILE="${RUN_DIR}/host_gateway.log"
DISCOVERY_PROXY_PID_FILE="${RUN_DIR}/discovery_proxy.pid"
SESSION_NAME="${NEWHORIZONS_GATEWAY_SCREEN_SESSION:-newhorizons-gateway-host}"
CONTAINER_NAME="${NEWHORIZONS_GATEWAY_CONTAINER_NAME:-newhorizons-gateway}"
PYTHON_BIN="${NEWHORIZONS_GATEWAY_PYTHON:-/usr/local/Caskroom/miniconda/base/envs/ctl-board/bin/python}"
CONFIG_FILE="${NEWHORIZONS_GATEWAY_CONFIG:-${RUN_DIR}/host_gateway_config.json}"
UDP_PORT="${NEWHORIZONS_GATEWAY_UDP_PORT:-13250}"
DISCOVERY_PORT="${NEWHORIZONS_GATEWAY_DISCOVERY_PORT:-22346}"
WEB_PORT="${NEWHORIZONS_GATEWAY_WEB_PORT:-5052}"

mkdir -p "${RUN_DIR}"

if [[ ! -x "${PYTHON_BIN}" ]]; then
  echo "ctl-board Python not found: ${PYTHON_BIN}" >&2
  echo "Set NEWHORIZONS_GATEWAY_PYTHON to the ctl-board python path." >&2
  exit 1
fi

if [[ -f "${PID_FILE}" ]]; then
  OLD_PID="$(cat "${PID_FILE}" || true)"
  if [[ "${OLD_PID}" == screen:* ]]; then
    OLD_SESSION="${OLD_PID#screen:}"
    screen -S "${OLD_SESSION}" -X quit >/dev/null 2>&1 || true
  elif [[ -n "${OLD_PID}" ]] && kill -0 "${OLD_PID}" >/dev/null 2>&1; then
    kill "${OLD_PID}" >/dev/null 2>&1 || true
  fi
fi
screen -S "${SESSION_NAME}" -X quit >/dev/null 2>&1 || true

if command -v docker >/dev/null 2>&1; then
  docker stop "${CONTAINER_NAME}" >/dev/null 2>&1 || true
fi

if [[ -f "${DISCOVERY_PROXY_PID_FILE}" ]]; then
  PROXY_PID="$(cat "${DISCOVERY_PROXY_PID_FILE}" || true)"
  if [[ -n "${PROXY_PID}" ]] && kill -0 "${PROXY_PID}" >/dev/null 2>&1; then
    kill "${PROXY_PID}" >/dev/null 2>&1 || true
  fi
fi

if command -v lsof >/dev/null 2>&1; then
  for SPEC in "UDP:${UDP_PORT}" "UDP:${DISCOVERY_PORT}" "TCP:${WEB_PORT}"; do
    while IFS= read -r LISTENER_PID; do
      [[ -z "${LISTENER_PID}" ]] && continue
      LISTENER_COMMAND="$(ps -p "${LISTENER_PID}" -o command= 2>/dev/null || true)"
      if [[ "${LISTENER_COMMAND}" == *"newhorizons_gateway.main"* || "${LISTENER_COMMAND}" == *"discovery_proxy.py"* ]]; then
        kill "${LISTENER_PID}" >/dev/null 2>&1 || true
      else
        echo "${SPEC} is already used by another process:" >&2
        echo "${LISTENER_COMMAND:-pid ${LISTENER_PID}}" >&2
        exit 1
      fi
    done < <(lsof -nP -ti"${SPEC}" 2>/dev/null || true)
  done
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    BUSY=0
    for SPEC in "UDP:${UDP_PORT}" "UDP:${DISCOVERY_PORT}" "TCP:${WEB_PORT}"; do
      if [[ -n "$(lsof -nP -ti"${SPEC}" 2>/dev/null || true)" ]]; then
        BUSY=1
      fi
    done
    [[ "${BUSY}" -eq 0 ]] && break
    sleep 0.2
  done
fi

export NEWHORIZONS_GATEWAY_CONFIG="${CONFIG_FILE}"
export NEWHORIZONS_GATEWAY_PYTHON="${PYTHON_BIN}"
export NEWHORIZONS_GATEWAY_SERVER_URL="${NEWHORIZONS_GATEWAY_SERVER_URL:-ws://127.0.0.1:5051/newhorizons/gateway/ws}"
export NEWHORIZONS_GATEWAY_DISCOVERY_ENABLED="${NEWHORIZONS_GATEWAY_DISCOVERY_ENABLED:-1}"
export NEWHORIZONS_GATEWAY_ID="${NEWHORIZONS_GATEWAY_ID:-}"
export NEWHORIZONS_GATEWAY_APP_DIR="${APP_DIR}"
export NEWHORIZONS_GATEWAY_APP_ROOT="${APP_DIR}"
export NEWHORIZONS_GATEWAY_RESTART_COMMAND="${NEWHORIZONS_GATEWAY_RESTART_COMMAND:-${SCRIPT_DIR}/start_gateway_host.sh}"
export NEWHORIZONS_GATEWAY_LOG="${LOG_FILE}"
export PYTHONUNBUFFERED=1

: > "${LOG_FILE}"
if command -v screen >/dev/null 2>&1; then
  screen -dmS "${SESSION_NAME}" /bin/bash -lc 'cd "${NEWHORIZONS_GATEWAY_APP_DIR}" && exec "${NEWHORIZONS_GATEWAY_PYTHON}" -m newhorizons_gateway.main --config "${NEWHORIZONS_GATEWAY_CONFIG}" >> "${NEWHORIZONS_GATEWAY_LOG}" 2>&1'
  echo "screen:${SESSION_NAME}" > "${PID_FILE}"
  PID="screen:${SESSION_NAME}"
else
  cd "${APP_DIR}"
  nohup "${PYTHON_BIN}" -m newhorizons_gateway.main --config "${CONFIG_FILE}" >>"${LOG_FILE}" 2>&1 &
  PID="$!"
  echo "${PID}" > "${PID_FILE}"
  disown "${PID}" >/dev/null 2>&1 || true
fi

sleep 0.8
if [[ "${PID}" == screen:* ]]; then
  SCREEN_READY=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    SCREEN_LIST="$(screen -list 2>/dev/null || true)"
    if [[ "${SCREEN_LIST}" == *"${SESSION_NAME}"* ]]; then
      SCREEN_READY=1
      break
    fi
    sleep 0.2
  done
  if [[ "${SCREEN_READY}" -ne 1 ]]; then
    echo "Host Gateway failed to start." >&2
    sed -n '1,120p' "${LOG_FILE}" >&2 || true
    exit 1
  fi
elif ! kill -0 "${PID}" >/dev/null 2>&1; then
  echo "Host Gateway failed to start." >&2
  sed -n '1,120p' "${LOG_FILE}" >&2 || true
  exit 1
fi

echo "New Horizons Gateway is running on host with ctl-board."
echo "PID: ${PID}"
echo "Gateway WebUI: http://127.0.0.1:${WEB_PORT}"
echo "Backend WSS: ${NEWHORIZONS_GATEWAY_SERVER_URL}"
echo "FindMe UDP: ${DISCOVERY_PORT}"
echo "Device UDP control/data: ${UDP_PORT}"
echo "Log: ${LOG_FILE}"
