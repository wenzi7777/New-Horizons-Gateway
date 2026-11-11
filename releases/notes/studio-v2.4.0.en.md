# studio-v2.4.0

**The relay id no longer changes by itself, sync and recording recovery are more reliable, and the new v2.0.F Vref panel (in Pocket too).**

## Relay id

- A config file that can't be read for a moment, or is damaged, no longer silently switches to a new relay id (it could change on every launch, so the server's Relays page kept growing). The app retries, then keeps the file as `.corrupt-…` and carries on with the id in it.
- NH Pocket makes a single id on its first launch.
- A start that fails halfway closes the connection it had opened, so no second connection with the same id is left behind.
- After the relay id changes, your own devices still reporting the old id aren't taken for someone else's, and a device you just added isn't let go at once.

## Sync and recordings

- When the server refuses the token (revoked, say), that sync pass stops and asks you to sign in again instead of marking every recording failed.
- An upload that stops moving counts as failed instead of being resent forever; a synced recording whose content changed is uploaded again; checksumming a large file no longer freezes Pocket.
- Recording recovery converts into a temporary folder and only then replaces the partial files, so a failed conversion no longer loses data.
- Changing settings such as theme or language no longer drops the server connection.
- Pocket's "Wi-Fi only" sync checks the network it is actually on.

## Vref panel (TIA-CTL v2.0.F)

- NH Studio: three status tiles (Vref and its zone, Rfb, rows at the rail), a segmented range-mode control, and a Vref slider whose bar marks safe, 700–800 mV and above 800 mV in green, yellow and red. Measuring Rfb, the calibration switch, the ceiling and the Vref sweep are under "Tools". The default ceiling is 700 mV.
- NH Pocket: the device screen has a new "Vref and range" section: Vref and its zone, Rfb, rows at the rail, the range switch, Measure Rfb and Vref back to 330 mV.

## Other

- NH Studio's update download now times out.

Goes with New Horizons OS v1.22.1 and Desktop v1.8.0.
