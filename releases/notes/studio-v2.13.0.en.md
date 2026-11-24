# studio-v2.13.0

**NH Studio and NH Pocket switch to the "Illustrated" interface: the device is a drawing of the board, with live values tied to the actual parts by leader lines. Once a device connects its settings show up right away, without pressing Refresh.**

## Illustrated interface (v2.0.F / v1.5.F / v1.0.F)

- Settings → General has a new "Interface" choice (Illustrated / Classic). Illustrated is the default; Classic brings back the cards. GCU LTS boards have no drawing and keep the existing cards.
- Device overview: a vector drawing of the board (positions from the PCB files, following the light or dark theme) with clickable values on both sides — battery, reading mode, scan FPS and matrix, connection, firmware, lights. A click opens the matching settings. Scan and pins are one "Matrix" label whose leader branches to both FPCs.
- Power and connection paths: USB-C / battery → charging → system, and device → relay → server, with the path in use drawn solid. Long text is shortened in the middle instead of being cut off.
- IO Visualizer: a close-up of both FPCs, one square per pin, lit when enabled.
- Reading mode, scan preset, stream buffer, update channel, theme and others use large choice buttons (a check on the selected one); nothing is sent until you press Apply, as before.
- While charging, the battery icon draws its bolt inside the battery with a cut-out outline, so it stands out.

## NH Studio

- When a device connects (or reconnects), Studio asks it for its status once, so the settings panel is no longer empty; without an answer it retries every 15 s, up to 5 times. The same applies to NH Pocket.
- Device settings are grouped like the Desktop's: Connection, Hardware, Streaming, Clock, Update, Maintenance, Apps, Diagnostics, Files, Experimental. "Overview" is now "Connection"; Restart moved to Maintenance, the filter and raw ADC to Experimental, the log to Files.
- Diagnostics gains the device health card (power-on time, boot and crash counts, reset reasons, OTA rollbacks, chip temperature, lowest free memory, Wi‑Fi disconnects), as on the Desktop.
- Tools → Device files is now the Desktop's Finder-style window: scopes on the left (with file counts), the file list, a preview pane you can hide, and storage in the footer.
- Fixed Copy always failing in "Generate code" and the IO window: Studio's own pages may now write to the clipboard (every other permission is still denied).

## Other

- Fixed the v1.5.F / v2.0.F digital FPC pin labels: contact 18 = GND, 17 = SCL (GPIO 42), 16 = SDA (GPIO 40), 15 = NC.
- Smaller IO Visualizer board picture (Studio 460 px, Pocket 280 pt); it shows where Rfb0–13 sit on the back of a v2.0.F and which are soldered.
- NH Pocket 2.13.0; NH Studio headless only changes its version. Goes with Desktop v1.16.0; no firmware update needed.
