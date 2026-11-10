# studio-v2.1.0

**A first-run guide, Desktop's device settings and visualization, the app's own controls everywhere, and a relay performance test. Labels and profiles are the server's; headless has the Hub's standing.**

## First run

- NH Studio and NH Pocket open with a guide: choose the server → sign in with a Desktop account (skippable) → upload recordings automatically or not → which devices to take.
- Devices default to "only the ones I add"; "every device that asks" is how the old NH Gateway worked. Settings can show the guide again.

## NH Studio

- Device settings follow Desktop: Overview, Hardware, Streaming, Update and Diagnostics, with the same cards and commands.
- The Live view is Desktop's visualization: 3D surface / 2D heat map, profile picker, mirrors, stats and centre of pressure.
- Every dropdown, field, checkbox and switch is the app's own component, nothing native; icon buttons are larger.
- Windows / Linux: no system title bar or menu bar, with drawn minimize / maximize / close buttons. macOS is unchanged.
- macOS is ad-hoc signed: Apple Silicon no longer says the app is damaged. On first open, press "Open Anyway" in System Settings → Privacy & Security.
- An "Open Desktop" button in the top bar.

## NH Pocket

- Switches, dropdowns (a bottom sheet) and fields are the app's own; the 2D heat map follows Desktop's layout, P numbers and legend, and a tap shows a cell's value.
- "Open Desktop" in Settings.

## Labels and profiles are the server's

- Nicknames, groups and profiles are no longer synced both ways: they are edited on the server, and the app keeps a read-only copy.
- Offline or signed out they cannot be edited; the app says it needs the server.

## Relay performance test

- Studio Tools → Relay performance, Pocket Settings → Relay performance, and `nh-studio --bench`: frames per second this machine handles, the round trip and upload to the server, the estimated number of devices and the bottleneck.

## NH Studio headless

- Same standing as the Hub: connection type `relay`, no sign-in, relays only, records nothing; `--login` and the web UI's sign-in card are gone.

## Other

- Released files are scanned by VirusTotal; the download page shows the results.
- Needs New Horizons Desktop v1.5.0 or later; best with firmware v1.20.0 (devices stop hopping between hosts).
