# studio-v2.9.0

**NH Studio and NH Pocket get the IO visualizer; Vref becomes manual plus two switches; recordings note how a v2.0.F read its rows.**

## IO visualizer

- NH Studio: the pin layout card in device settings has "Open IO visualizer": the board picture on the left (v1.0.F, v1.5.F, v2.0.F, GCU v2.1 / v2.2.C / v2.3.D), and on the right the analog and select pins to tap in matrix order, applied at once or copied as a terminal command, as in the Desktop.
- NH Pocket: the device screen has "IO Visualizer": the board picture, then the pins to tap in order, applied after a confirmation (`set_matrix_layout`).
- Each board's pin data moved to `@nhgw/host`, shared by Studio and Pocket.

## Vref (TIA-CTL v2.0.F)

- In Studio and Pocket, Raw / Virtual Rfb / Auto are two switches: "Convert to the reference scale" and, on top of it, "Smart Vref". Both off is manual, read the way v1.5.F and earlier boards read; Smart Vref needs the conversion on. Studio's reference Rfb and leak compensation moved to "Advanced".
- The external LED mode is a switch.

## Recording

- `.meta.json` has a new `range` block (mode, Vref, reference Rfb, leak compensation, per-row Rfb and offset; v2.0.F only), with changes during a recording logged in `changes`. Byte for byte the same as New Horizons Desktop v1.13.0.

## Other

- The FindMe card no longer flips between two sets of values: the relay's presence snapshot no longer overwrites the relay address and uptime ms the device reports itself, and "Last success" reads as seconds after boot.
- Apps: a running card shows the external LED strip and says "shared" when more than one app may light it.
- Pairs with New Horizons OS v2.1.0 and New Horizons Desktop v1.13.0.
