# studio-v2.3.0

**Recording analysis in NH Pocket, and NH Studio opens a CSV together with its events and meta.**

## NH Pocket

- New **Analysis** screen for each recording (open a recording, then "Analyze"): overview, a trace of total / peak / contact area / one sensor that you can drag along or play back at 0.5×, 1×, 2× or 4×, a heatmap of the frame under the cursor (or the mean / peak of the visible range), sampling quality with a list of lost frames, gaps and restarts you can tap to jump to, per-sensor statistics and the recording's events.
- Pocket reads the CSV in slices, so long recordings do not freeze the screen. It analyses the recordings made on the phone.

## NH Studio

- Tools > Recording analysis: opening a CSV from disk (for example a Desktop export) now also loads the `.events.csv` and `.meta.json` beside it, so the events, device information and the heatmap's column count appear.
- The Recordings page has an **Analyze** button that opens the selected recording in the analysis tool.
