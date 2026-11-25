# studio-v2.14.0

**Live gains Transpose; NH Pocket's live screen now has everything the Desktop Visualization card has (3D included); Gyro / Acc are drawn as graphics, and the magnetometer is shown.**

## Transpose (NH Studio / NH Pocket)

- A Transpose checkbox next to Row Mirror / Col Mirror swaps rows and columns (6 × 8 shows as 8 × 6); heatmap, 3D surface, COP and the size label follow. Transpose first, then mirror: the three checkboxes give all 8 orientations.
- Display only: recordings are unchanged, P numbers stay with their sensors and the A.. / D.. pin labels swap with the axes. Not available while a sensor-layout profile is selected.
- NH Studio: with a profile, the mirrors now move the sensors (each keeps its own value), as on the Desktop; before, a dot could show another sensor's value.

## NH Pocket live screen

- 3D surface (drag to orbit, pinch to zoom; drawn only when something changes, stopped off screen) or 2D heatmap; falls back to 2D on phones that cannot draw 3D.
- Sensor-layout profiles (synced from the server; sign in under Settings) drawn as dots over the profile's picture, with a dot size.
- Row Mirror / Col Mirror / Transpose and the matrix size; stats: samples, Device FPS, Render FPS, Max P, mean, COP.
- Each device's view is remembered.

## IMU and magnetometer (NH Studio / NH Pocket)

- Gyro / Acc become three panels, each a gauge + the last 10 s of X / Y / Z as trend lines + the values in the same colours: accelerometer (spirit level, |a|, roll / pitch), gyroscope (centred bars, 30–2000 °/s auto scale), magnetometer (new; a dial with the heading of the board's +X, tilt-compensated with the accelerometer, µT and |B|; the heading is raw). Devices without a magnetometer say so.

## Other

- NH Pocket 2.14.0 (adds the expo-gl native module); NH Studio headless only changes its version. Goes with Desktop v1.17.0; no firmware update needed.
