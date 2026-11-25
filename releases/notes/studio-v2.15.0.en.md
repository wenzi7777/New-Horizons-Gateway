# studio-v2.15.0

**NH Studio and NH Pocket get a magnetometer on/off switch (off by default) and a hard/soft-iron calibration wizard, with reminders when the calibration is due or looks off.**

## Magnetometer switch (NH Studio / NH Pocket)

- A magnetometer block in device settings: an On / Off menu with Apply, and the calibration reminder interval (7 / 14 / 30 / 90 days or never). In NH Studio it sits next to the IMU; in NH Pocket it is on the device screen.
- Choosing On and applying goes straight into the calibration wizard. Leaving it without applying a calibration switches the magnetometer off again.
- Shows the chip's ODR, averaging and measured rate. On GCU boards with the IMU off, it says the magnetometer is blocked by the IMU.

## Calibration wizard

- **Prepare**: fit the case and battery, and keep away from laptops, steel desks and motors.
- **Rotate**: an animation shows the moves (figure eight, then each face). A sphere split into 26 cells lights up the directions already covered and marks the next one, with a coverage ring and point count underneath.
- **Result**: before/after projections, the field strength, the residual (above 5% it suggests redoing) and the mode. With at least 70% coverage and 300 points it fits a full ellipsoid; with less it calibrates hard iron only. The new fit is layered on the calibration in use, and cancelling keeps the old one.
- The maintenance block can redo or clear the calibration at any time.

## Reminders

- While the magnetometer is on, the device list shows a badge when the calibration is due within 3 days, overdue, suspected off, or missing, and device settings show a banner with Calibrate now. They only remind; recording and streaming are never blocked.

## Other

- NH Studio's IMU details show the chip's ODR; the terminal gains `set-mag` / `set-mag-calibration` command builders.
- NH Pocket 2.15.0; NH Studio headless relays the new commands. Needs firmware v2.4.0; pairs with Desktop v1.18.0.
