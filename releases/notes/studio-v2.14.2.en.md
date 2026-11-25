# studio-v2.14.2

**Fixes NH Pocket closing when switching to 3D; the device screen opens smoothly; 3D opens at an angle.**

## NH Pocket

- 3D crash: the release build's code shrinking removed part of the 3D view, so switching to 3D closed the app. 3D now shows normally (tested on a Pixel 4a).
- Safeguards: if 3D still cannot be shown, the screen falls back to 2D with a note; an error on any other screen shows Retry instead of closing the app.
- Opening a device: the board drawing and data path appear once the opening animation has finished, so it no longer stutters; the same goes for the live screen's heat map / 3D and IMU panels and the IO Visualizer's pin map. The device screen no longer redraws in full when the fps number or a timer changes.
- 3D starts at the Desktop's angled view instead of looking straight down.

## Other

- NH Pocket 2.14.2; NH Studio and NH Studio headless only change their version. No Desktop or firmware update needed.
