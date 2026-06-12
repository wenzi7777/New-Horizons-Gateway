# New Horizons Gateway

Standalone LAN relay for New Horizons devices. The Gateway runs separately
from the main New Horizons WebUI/backend, so it can sit on any computer in the
same LAN as the devices.

The Gateway is host-only. It must run directly on the LAN host so UDP source
addresses and reply paths remain valid. Docker Desktop rewrites these addresses
and is not supported for the Gateway. The Desktop WebUI/backend may still run
in Docker.

## First Setup

Open the local Gateway UI:

```text
http://127.0.0.1:5052/
```

On first launch the Gateway is disabled and opens a setup wizard. Set a
`Gateway ID` before enabling it:

- Click `Auto set` to generate an ID like `nh-gateway-xxxxxx`.
- Or enter an ID manually. Allowed characters are `A-Z a-z 0-9 . _ -`, max 64
  characters.
- Click `Continue`.
- Turn on `Enabled` and save.

When `Enabled` is off, only the Gateway WebUI runs. Upstream WSS, UDP
control/data, and FindMe discovery stay stopped.

## Ports

Devices find this Gateway through New Horizons FindMe:

- UDP FindMe: `22346`
- UDP control and sensor data: `13250`
- Gateway WebUI: `5052`

The Gateway then forwards data and control messages to the New Horizons backend
WebSocket.

```text
Device <-> Gateway                 Gateway <-> Backend
FindMe + UDP control/data           WebSocket / WSS
```

## Target Server Modes

The Gateway owns the upstream server configuration; the device only needs Wi-Fi.

- `Production`: `wss://isensing-s1.u-aizu.ac.jp/newhorizons/gateway/ws`
- `Local`: `ws://127.0.0.1:5051/newhorizons/gateway/ws`
- `Manual`: custom `ws://` or `wss://` URL

Changes made in the Gateway WebUI are persisted to the Gateway config and apply
without manually restarting the process.

## Local Start

Start the Gateway separately:

```bash
cd /Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Gateway
./scripts/start.sh
```

The script creates `.venv` when needed and preserves Gateway configuration in
`.run/config.json`. Before startup it verifies that UDP `22346`, UDP `13250`,
and TCP `5052` are free. If a legacy Docker Gateway still owns those ports,
stop and remove that container first.

On Windows, use PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\start.ps1
```

Start the main WebUI/backend separately:

```bash
cd /Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop
./scripts/start_local.sh --build
```

## Update

The Gateway WebUI has an `Update` section:

1. `Check for update` reads `releases/gateway-latest.json`.
2. `Download update` downloads the source zip and verifies SHA-256.
3. `Apply update` stages the update.
4. `Restart Gateway` uses `NEWHORIZONS_GATEWAY_RESTART_COMMAND` when configured.

Host self-update is intentionally gated behind:

```bash
export NEWHORIZONS_GATEWAY_ALLOW_SELF_UPDATE=1
```

## Run On Another Computer

Use the Gateway WebUI target settings, or set the backend URL before starting:

```bash
export NEWHORIZONS_GATEWAY_SERVER_URL=ws://192.168.1.153:5051/newhorizons/gateway/ws
./scripts/start.sh
```

For lab deployment:

```bash
export NEWHORIZONS_GATEWAY_SERVER_URL=wss://isensing-s1.u-aizu.ac.jp/newhorizons/gateway/ws
./scripts/start.sh
```

## Stop

```bash
cd /Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Gateway
./scripts/stop.sh
```

## Direct Python Run

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python -m newhorizons_gateway.main --config config.example.json
```

## FindMe Wire Types

FindMe uses JSON UDP datagrams. Device broadcast:

```json
{
  "type": "findme_discover",
  "device_uid": "3CDC7545CCD0",
  "mode": "normal"
}
```

Gateway offer:

```json
{
  "type": "findme_offer",
  "device_uid": "3CDC7545CCD0",
  "gateway_name": "New Horizons Gateway",
  "gateway_id": "nh-gateway-xxxxxx",
  "udp_port": 13250,
  "priority": 100,
  "accept": true,
  "upstream_status": "online",
  "ttl_ms": 10000
}
```
