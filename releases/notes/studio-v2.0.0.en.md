# studio-v2.0.0

**The first New Horizons Studio: NH Studio for computers, NH Studio headless for machines without a screen, and New Horizons Studio Pocket for phones. It replaces NH Gateway.**

## NH Studio (macOS / Windows / Linux)

- Manage devices right on this computer: list, add and release, device settings, live view (2D/3D), recording and CSV export, profile editor, App Library and App Studio, tools (recording analysis, terminal, device files, timestamp converter, pressure control) and the full calibration workbench.
- Connected to a Desktop server it takes the software Gateway's place and relays devices there; the server's Relays page shows it as NH Studio.
- Sign in with a Desktop account to sync recordings, device nicknames, groups and profiles automatically.
- A start-up screen initializes and checks for updates; the settings page is regrouped.

## NH Studio headless (`nh-studio`)

- For computers without a screen (the machines that ran the Python Gateway). Started in the old Gateway's folder it takes the settings over; the Gateway ID stays.
- `nh-studio --login` signs in with a Desktop account; the web UI is on port 5052. It updates itself and rolls back if the new version fails.

## New Horizons Studio Pocket (Android)

- Device management, live heat map, offline recording (kept on the phone, exportable), and automatic upload once signed in.
- In-app update: Settings → Software update.

## Notes

- This release is not code-signed: on macOS allow it once in System Settings → Privacy & Security; Windows shows a SmartScreen prompt; on Android allow installs from this source.
- Needs New Horizons Desktop v1.4.0 or later on the server.
