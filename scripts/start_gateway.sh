#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

BUILD=0
HOST_GATEWAY=1
HOST_DISCOVERY=1
CONTAINER_NAME="${NEWHORIZONS_GATEWAY_CONTAINER_NAME:-newhorizons-gateway}"

for arg in "$@"; do
  case "${arg}" in
    --build)
      BUILD=1
      ;;
    --host)
      HOST_GATEWAY=1
      ;;
    --docker)
      HOST_GATEWAY=0
      ;;
    --host-discovery)
      HOST_DISCOVERY=1
      ;;
    --container-discovery)
      HOST_GATEWAY=0
      HOST_DISCOVERY=0
      ;;
    *)
      echo "Unknown option: ${arg}" >&2
      echo "Usage: $0 [--build] [--host] [--docker] [--host-discovery] [--container-discovery]" >&2
      exit 2
      ;;
  esac
done

if [[ "${HOST_GATEWAY}" -eq 1 ]]; then
  if [[ "${BUILD}" -eq 1 ]]; then
    echo "Host Gateway uses local ctl-board Python; --build is ignored."
  fi
  exec "${SCRIPT_DIR}/start_gateway_host.sh"
fi

cd "${APP_DIR}"

COMPOSE_FILE="${APP_DIR}/docker-compose.yml"
COMPOSE_ARGS=(-f "${COMPOSE_FILE}")
if [[ "${HOST_DISCOVERY}" -eq 0 ]]; then
  COMPOSE_ARGS+=(-f "${APP_DIR}/docker-compose.container-discovery.yml")
fi
EXISTING_CONTAINER="$(docker ps -aq --filter "name=^/${CONTAINER_NAME}$" | head -n 1 || true)"
if [[ -n "${EXISTING_CONTAINER}" ]]; then
  EXISTING_CONFIG_FILES="$(
    docker inspect "${EXISTING_CONTAINER}" \
      --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' 2>/dev/null || true
  )"
  if [[ "${EXISTING_CONFIG_FILES}" != *"${COMPOSE_FILE}"* ]]; then
    LEGACY_MAIN_COMPOSE="${APP_DIR%/newhorizons-gateway}/newhorizons/docker-compose.yml"
    if [[ "${EXISTING_CONFIG_FILES}" == *"${LEGACY_MAIN_COMPOSE}"* ]]; then
      echo "Found legacy Gateway container from ${LEGACY_MAIN_COMPOSE}; replacing it with standalone Gateway."
      docker rm -f "${EXISTING_CONTAINER}" >/dev/null
    else
      echo "A container named ${CONTAINER_NAME} already exists but was not created by this Gateway app." >&2
      echo "Container: ${EXISTING_CONTAINER}" >&2
      echo "Compose config: ${EXISTING_CONFIG_FILES:-unknown}" >&2
      echo "Stop or rename that container before starting this Gateway." >&2
      exit 1
    fi
  fi
fi

if [[ "${HOST_DISCOVERY}" -eq 1 ]]; then
  export NEWHORIZONS_GATEWAY_DISCOVERY_ENABLED=0
else
  export NEWHORIZONS_GATEWAY_DISCOVERY_ENABLED="${NEWHORIZONS_GATEWAY_DISCOVERY_ENABLED:-1}"
fi

UP_ARGS=(up -d)
if [[ "${BUILD}" -eq 1 ]]; then
  UP_ARGS+=(--build)
fi

docker compose "${COMPOSE_ARGS[@]}" "${UP_ARGS[@]}"

echo "New Horizons Gateway is running."
echo "Gateway WebUI: http://127.0.0.1:${NEWHORIZONS_GATEWAY_WEB_PORT:-5052}"
echo "Upstream mode: ${NEWHORIZONS_GATEWAY_TARGET_MODE:-saved-config}"
echo "Device UDP control/data: ${NEWHORIZONS_GATEWAY_UDP_PORT:-13250}"

if [[ "${HOST_DISCOVERY}" -eq 1 ]]; then
  RUN_DIR="${APP_DIR}/.run"
  mkdir -p "${RUN_DIR}"
  PROXY_PID_FILE="${RUN_DIR}/discovery_proxy.pid"
  PROXY_LOG_FILE="${RUN_DIR}/discovery_proxy.log"
  DISCOVERY_PORT="${NEWHORIZONS_GATEWAY_DISCOVERY_PORT:-22346}"
  if [[ -f "${PROXY_PID_FILE}" ]]; then
    OLD_PID="$(cat "${PROXY_PID_FILE}" || true)"
    if [[ -n "${OLD_PID}" ]] && kill -0 "${OLD_PID}" >/dev/null 2>&1; then
      kill "${OLD_PID}" >/dev/null 2>&1 || true
    fi
  fi
  if command -v lsof >/dev/null 2>&1; then
    while IFS= read -r LISTENER_PID; do
      [[ -z "${LISTENER_PID}" ]] && continue
      LISTENER_COMMAND="$(ps -p "${LISTENER_PID}" -o command= 2>/dev/null || true)"
      if [[ "${LISTENER_COMMAND}" == *"discovery_proxy.py"* ]]; then
        kill "${LISTENER_PID}" >/dev/null 2>&1 || true
      else
        echo "UDP ${DISCOVERY_PORT} is already used by another process:" >&2
        echo "${LISTENER_COMMAND:-pid ${LISTENER_PID}}" >&2
        exit 1
      fi
    done < <(lsof -nP -tiUDP:"${DISCOVERY_PORT}" 2>/dev/null || true)
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if [[ -z "$(lsof -nP -tiUDP:"${DISCOVERY_PORT}" 2>/dev/null || true)" ]]; then
        break
      fi
      sleep 0.2
    done
    if [[ -n "$(lsof -nP -tiUDP:"${DISCOVERY_PORT}" 2>/dev/null || true)" ]]; then
      echo "UDP ${DISCOVERY_PORT} did not become free after stopping the old discovery proxy." >&2
      exit 1
    fi
  fi
  nohup python3 "${APP_DIR}/scripts/discovery_proxy.py" \
    --gateway-id "${NEWHORIZONS_GATEWAY_ID:-local-gateway}" \
    --tcp-port "0" \
    --udp-port "${NEWHORIZONS_GATEWAY_UDP_PORT:-13250}" \
    --port "${DISCOVERY_PORT}" \
    --priority "${NEWHORIZONS_GATEWAY_DISCOVERY_PRIORITY:-100}" \
    --status-url "http://127.0.0.1:${NEWHORIZONS_GATEWAY_WEB_PORT:-5052}/api/status" \
    </dev/null >"${PROXY_LOG_FILE}" 2>&1 &
  PROXY_PID="$!"
  echo "${PROXY_PID}" > "${PROXY_PID_FILE}"
  disown "${PROXY_PID}" >/dev/null 2>&1 || true
  sleep 0.5
  if ! kill -0 "${PROXY_PID}" >/dev/null 2>&1; then
    echo "Host discovery proxy failed to start." >&2
    sed -n '1,80p' "${PROXY_LOG_FILE}" >&2 || true
    exit 1
  fi
  echo "Host discovery proxy: UDP ${DISCOVERY_PORT}"
  echo "Discovery proxy log: ${PROXY_LOG_FILE}"
else
  echo "Container discovery: UDP ${NEWHORIZONS_GATEWAY_DISCOVERY_PORT:-22346}"
fi
