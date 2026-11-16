# studio-v2.10.0

**TIA-CTL v2.0.F readings are now one of ADC mV, conductance in µS, or conductance with smart Vref, and calibration works in conductance too; recordings also keep each frame's unit, Vref and saturated rows.**

## Reading modes (TIA-CTL v2.0.F)

- NH Studio: the reference voltage card's reading is one select (ADC mV, conductance, conductance with smart Vref), sent with Apply. "Scale" and the reference Rfb are gone, and the Rfb table shows each row's status.
- NH Pocket: the reading is a three-way segmented control (raw, µS, µS smart), sent with Apply.
- Conductance needs Rfb measured first; unmeasured rows read 0.

## Recording

- When the device sends per-frame range information, the CSV gains `range_unit`, `vref_mv` and `saturated_rows`, byte for byte the same as the Desktop's recordings.
- The `.meta.json` range block records the reading mode, output unit, smart Vref, Vref, Rfb, offsets and each row's status; the calibration block records the profile's unit (`unit`).

## Calibration (NH Studio)

- The calibration page shows the profile's unit. When it differs from the current output unit it says the profile is kept but not applied; in conductance it notes that the calibration stays valid when Vref changes.
- Sensors without an Rfb are not fit failures, and progress counts only sensors with an Rfb.
- New error messages: the output unit changed during calibration, and the profile is in the other unit.

## Other

- Goes with New Horizons OS v2.2.0 and New Horizons Desktop v1.14.0.
