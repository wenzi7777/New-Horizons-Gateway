# studio-v2.14.1

**NH Pocket performance fix: on mid-range phones such as the Pixel 4a, 2.14.0 felt slow overall, the IO Visualizer and the live screen stuttered, and switching to 3D closed the app.**

## NH Pocket

- Overall: while a device streamed, the whole app redrew every 0.25 s, including tabs you could not see. Screens now redraw only when the data they show actually changes, and screens you leave are paused.
- IO Visualizer: the board drawing and pins no longer redraw with every device update; tapping a pin updates only that pin.
- Live screen: no longer redraws the whole page for every frame. The heat map / 3D view updates at most 15 times a second, the IMU panels 8 times, the numbers 4 times; the heat map updates only cells whose colour or value changed. Samples still counts every frame received.
- 3D crash: the 3D surface is now drawn with a small built-in WebGL 1 renderer instead of three.js, which needs WebGL 2 that phones only partly provide. It looks and handles the same; if a phone still cannot show 3D, the screen switches to 2D with a note instead of closing.

## Other

- NH Pocket 2.14.1; NH Studio and NH Studio headless only change their version. No Desktop or firmware update needed.
