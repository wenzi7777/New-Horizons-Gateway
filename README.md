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

On first launch the Gateway is disabled and opens a three-step setup wizard:

1. **ID** -- click `Generate` for an ID like `nh-gateway-xxxxxx`, or type one
   (`A-Z a-z 0-9 . _ -`, max 64 characters).
2. **Server** -- Production, Local, or Manual (a `ws://` / `wss://` address).
3. **Start** -- check the settings and click `Enable & start`.

After setup the page is laid out like the Desktop app's Gateway dialog:
overview cards on top (status, version, server, serving devices) and four
sections -- Overview, LAN devices, Connection, Software update. Advanced
update details (A/B slots, boot phase, update signal) and the take-over request
log sit under `Technical details`. Light/dark follows the Desktop app (auto
switches at sunrise and sunset at the lab; the topbar button cycles auto /
light / dark). The page is plain files in `newhorizons_gateway/webui/`
(no build step), served by `web.py`.

Under Connection, `Accept remote management` (on by default) lets the Desktop
app manage this Gateway; off, every `gateway_command` is refused with
`remote_management_disabled`. Only this local page can change it.

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

## Device Time

WiFi-mode devices (firmware v1.12.0+) set their clocks from this Gateway:
they send a 12-byte time request to UDP `13250`, and the Gateway replies with
its own wall-clock time, timed NTP-style so the network delay cancels out
(`newhorizons_gateway/time_service.py`). Every device behind one Gateway
therefore shares a single clock, which keeps multi-device recordings aligned.

The Gateway's time is the host OS clock, so keep the host's automatic time
(NTP) enabled -- it is on by default on Windows, macOS and Linux. Devices fall
back to an NTP server of their own when no Gateway answers (including older
Gateway versions, which ignore the request). Time requests are answered
locally and never forwarded upstream.

## Target Server Modes

The Gateway owns the upstream server configuration; the device only needs Wi-Fi.

- `Production`: `wss://isensing-s1.u-aizu.ac.jp/newhorizons/gateway/ws`
- `Local`: `ws://127.0.0.1:5051/newhorizons/gateway/ws`
- `Manual`: custom `ws://` or `wss://` URL

Changes made in the Gateway WebUI are persisted to the Gateway config and apply
without manually restarting the process.

## Local Start

Start the Gateway separately with Python on macOS, Linux, or Windows:

```bash
cd /Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Gateway
python scripts/start.py
```

The launcher creates `.venv` when needed and preserves Gateway configuration in
`.run/config.json`. Before startup it verifies that UDP `22346`, UDP `13250`,
and TCP `5052` are free. If a legacy Docker Gateway still owns those ports,
stop and remove that container first.

Start the main WebUI/backend separately:

```bash
cd /Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop
./scripts/start_local.sh --build
```

## Update

The Gateway WebUI has a `Software update` section:

1. The Desktop backend WebSocket tells the Gateway the latest allowed version
   on the Gateway's update channel (sent in `hello`).
2. `Check` reads the channel's manifest when update metadata is needed:
   `releases/gateway-latest.json` (stable, the default) or
   `releases/gateway-beta.json` (beta).
3. `Update now` downloads the source zip, verifies SHA-256, and stages the new
   version into the inactive A/B slot.
4. The bootloader switches from the active slot to the staged slot.
5. The new slot must report local health (`health.json` + WebUI port ready) or
   the bootloader rolls back automatically.

If the backend reports a newer Gateway version, the Gateway shows a mandatory
update dialog and blocks normal operations until the update is applied.
Since v1.0.0 it also applies that update by itself, like a Hub: after 60 s
from start-up, once no device has been served for 60 s. An attempt that
leaves the Gateway running (download error, manifest not newer yet) waits
30 min before the next try (`auto_apply`: `waiting_for_idle` / `retry_later`).

### Update channels

`Software update` → `Update channel` switches between `stable` and `beta`
(stored as `update_channel` in `.run/config.json`, or
`NEWHORIZONS_GATEWAY_UPDATE_CHANNEL`). Beta versions carry a prerelease
suffix (`v0.7.1-beta.1`) and sort below their release; switching back to
stable never downgrades, and clears a beta-only mandatory update.

Publishing: a stable release writes `releases/gateway-latest.json` as before,
and also `releases/gateway-beta.json` unless that already holds a newer beta.
A beta release writes only `releases/gateway-beta.json` (same fields:
`version`, `zip_url`, `sha256`, `notes_url`). Never put a prerelease in
`gateway-latest.json`: every Gateway older than v0.7.0 reads only that file.

If you launched the Gateway through `python scripts/start.py`, slot switching
and rollback are already wired up by the bootloader. The bootloader itself is
not updated by daily OTA; the first bootloader-capable release must be
installed manually.

## Remote Management (Desktop)

Since v1.0.0 the Desktop app manages a Gateway the way it manages a Hub
(Relays page → `Manage` on the Gateway card). The Gateway's `hello` carries
`client_type: "gateway"` and `capabilities: ["gateway_command", "auto_update"]`;
the Desktop sends `gateway_command` over the same upstream WebSocket and the
Gateway answers with `gateway_command_result` (`newhorizons_gateway/remote_commands.py`).

| Command | Args | Notes |
|---|---|---|
| `set_config` | `gateway_id`, `target_mode`, `manual_url` | Locked by a required update; replies, then reconnects. `enabled` and `remote_management` are never changed remotely |
| `check_update` | | `update_available` / `up_to_date` / `update_check_failed` |
| `apply_update` | | Same as `Update now` |
| `set_update_channel` | `channel` | Never locked |
| `restart` | | Restarts in-process (no slot switch) |
| `factory_reset` | | First-run settings (disabled, no ID; ports kept) -- the Gateway goes offline until set up in its WebUI again |
| `discover`, `device_reject`, `device_allow`, `device_serve` | `device_uid` | Same as the WebUI device actions; locked by a required update |

The WebUI and the Desktop go through the same code (`operations.py`). With
`Accept remote management` turned off in the WebUI, every command above is
refused (`remote_management_disabled`) and `gateway_status` reports
`remote_management: false`, so the Desktop shows the Gateway read-only.
`gateway_status` carries an `update` block (field names as the Hub's).

## Run On Another Computer

Use the Gateway WebUI target settings, or set the backend URL before starting:

```bash
export NEWHORIZONS_GATEWAY_SERVER_URL=ws://192.168.1.153:5051/newhorizons/gateway/ws
python scripts/start.py
```

For lab deployment:

```bash
export NEWHORIZONS_GATEWAY_SERVER_URL=wss://isensing-s1.u-aizu.ac.jp/newhorizons/gateway/ws
python scripts/start.py
```

## Stop

```bash
cd /Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Gateway
python scripts/stop.py
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
