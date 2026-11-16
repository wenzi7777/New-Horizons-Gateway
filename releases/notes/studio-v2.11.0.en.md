# studio-v2.11.0

**Added devices no longer need "Discover devices": they are listed as soon as NH Studio / Pocket starts and taken back as soon as they are heard. A device taken over by another relay is listed too and can be taken back from there. Adding and taking over now say clearly when they fail.**

## My devices

- The list follows the saved added devices: a device not heard yet shows as offline (name, model, firmware version and last address from the last record) instead of disappearing.
- A device taken over by another relay shows "Taken over" with "Take back", so taking over no longer needs the headless WebUI's discovery.

## Finding devices again

- While an added device is not being served, a discovery goes out automatically (once at start, then every 10 s, every 30 s after 2 minutes without finding it) and is also sent unicast to the device's last address, so networks that do not forward broadcast work too.
- The last address of every added device is remembered (written only when the address or identity changes). Headless does the same.

## Adding and taking over

- The takeover command goes to the device's latest FindMe address, its stream address or the remembered address, in that order; with none of them it discovers for up to 6 s first.
- It then waits up to 12 s for the device to actually attach before reporting success. New error messages: "Device unreachable" (no address for the device) and "Device did not attach" (timed out). After a failure the device stays in the list and attaches on its own once heard.
- "Discover devices" also goes unicast to the remembered addresses of added devices.

## Other

- Goes with New Horizons OS v2.3.0 (devices renew their attachment and move within about 15 s when a relay closes or changes IP); older firmware works too. Desktop needs no update.
