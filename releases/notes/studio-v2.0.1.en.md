# studio-v2.0.1

**Fix: when NH Studio and NH Pocket both managed the same device, the device kept hopping between them.**

## Cause

- A device sends FindMe every 3 seconds and takes the first offer of each round. With two hosts managing it, it switched to whichever reply arrived first, so it changed hosts every few seconds.

## Fix

- The host the device streams to answers at once; any other host answers 250 ms later, so the device stays where it is.
- When that host is off or disconnected, another host's answer still counts and the device moves on its own.
- Pressing "Add" on another host takes effect at once (an answer with a claim is always immediate).
- Fixed in NH Studio, NH Studio headless and NH Pocket. Pocket v2.0.0 can update from inside the app (Settings → Software update).

## Note

- The old Python Gateway answers at once, so it still competes with Studio / Pocket for devices; switch it to NH Studio headless.
