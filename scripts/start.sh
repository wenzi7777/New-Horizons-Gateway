#!/usr/bin/env bash
# Start the Gateway on the host (recommended for macOS / Linux).
# Running on the host preserves the real device UDP source IP,
# which is required for the gateway to send UDP commands back to devices.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
RUN_DIR="${APP_DIR}/.run"
PID_FILE="${RUN_DIR}/gateway.pid"
LOG_FILE="${RUN_DIR}/gateway.log"
CONFIG_FILE="${RUN_DIR}/config.json"
VENV="${APP_DIR}/.venv"

mkdir -p "${RUN_DIR}"

# Stop any already-running instance
if [[ -f "${PID_FILE}" ]]; then
  OLD_PID="$(cat "${PID_FILE}" 2>/dev/null || true)"
  if [[ -n "${OLD_PID}" ]] && kill -0 "${OLD_PID}" 2>/dev/null; then
    kill "${OLD_PID}"
    echo "Stopped previous instance (PID ${OLD_PID})."
    sleep 1
  fi
  rm -f "${PID_FILE}"
fi

check_port_free() {
  local protocol="$1"
  local port="$2"
  local owner=""
  if command -v lsof >/dev/null 2>&1; then
    if [[ "${protocol}" == "UDP" ]]; then
      owner="$(lsof -nP -iUDP:"${port}" 2>/dev/null || true)"
    else
      owner="$(lsof -nP -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true)"
    fi
  elif command -v ss >/dev/null 2>&1; then
    if [[ "${protocol}" == "UDP" ]]; then
      owner="$(ss -H -lunp "sport = :${port}" 2>/dev/null || true)"
    else
      owner="$(ss -H -ltnp "sport = :${port}" 2>/dev/null || true)"
    fi
  else
    echo "ERROR: Cannot verify ${protocol}/${port}; install lsof or iproute2 (ss)." >&2
    exit 1
  fi
  if [[ -z "${owner}" ]]; then
    return
  fi
  if grep -qi "docker" <<<"${owner}"; then
    echo "ERROR: Legacy Docker Gateway is still using ${protocol}/${port}." >&2
    echo "Stop and remove the old container before starting the host-only Gateway:" >&2
    echo "  docker rm -f newhorizons-gateway" >&2
  else
    echo "ERROR: ${protocol}/${port} is already in use:" >&2
    echo "${owner}" >&2
  fi
  exit 1
}

check_port_free UDP 22346
check_port_free UDP 13250
check_port_free TCP 5052

# Create virtualenv on first run
if [[ ! -x "${VENV}/bin/python" ]]; then
  echo "Creating .venv ..."
  python3 -m venv "${VENV}"
fi

"${VENV}/bin/pip" install -q -r "${APP_DIR}/requirements.txt"

# Create config from example on first run
if [[ ! -f "${CONFIG_FILE}" ]]; then
  cp "${APP_DIR}/config.example.json" "${CONFIG_FILE}"
  echo "Created ${CONFIG_FILE} — open the WebUI to finish setup."
fi

# Launch
: > "${LOG_FILE}"
PYTHONUNBUFFERED=1 nohup \
  "${VENV}/bin/python" -m newhorizons_gateway.main --config "${CONFIG_FILE}" \
  >> "${LOG_FILE}" 2>&1 &
PID=$!
echo "${PID}" > "${PID_FILE}"
disown "${PID}" 2>/dev/null || true

sleep 1
if ! kill -0 "${PID}" 2>/dev/null; then
  echo "ERROR: Gateway failed to start." >&2
  head -30 "${LOG_FILE}" >&2
  exit 1
fi

echo "Gateway started   PID ${PID}"
echo "WebUI             http://127.0.0.1:5052"
echo "Log               ${LOG_FILE}"
