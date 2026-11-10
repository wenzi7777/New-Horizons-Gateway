# `.nhraw` — NH Pocket raw capture (version 1)

NH Pocket's native side appends every datagram of the recorded device to a
`.nhraw` file as it arrives, so a throttled JS thread loses nothing. After the
recording, `convertRaw()` (nhraw.ts) replays the file through
`parseBinaryPacket` and `DeviceRecorder`, producing the same
`.data.csv` / `.events.csv` / `.meta.json` as recording live. All integers are
little-endian.

## Header (24 bytes)

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | magic `NHRW` (`4E 48 52 57`) |
| 4 | 2 | version, `1` |
| 6 | 2 | header length in bytes (`24`; readers skip anything beyond what they know) |
| 8 | 6 | device UID (the packet's 6 UID bytes; `3CDC7545CCD0` → `3C DC 75 45 CC D0`) |
| 14 | 2 | reserved, `0` |
| 16 | 8 | start time, µs since the Unix epoch (int64): when the recording switch was turned on |

## Records, until end of file

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | length `L` of the rest of the record (`9 + payload length`) |
| 4 | 8 | `rxEpochUs`: arrival time, µs since the Unix epoch (int64) |
| 12 | 1 | source: `0` stream, `1` control, `2` event |
| 13 | L-9 | payload |

A record cut short at the end of the file (the app was killed mid-write) is
dropped and reported as `truncated`. Records with an unknown source are
skipped.

- **stream** — a datagram from the stream port, byte for byte (v3/v4/v5
  packets; heartbeats and other UIDs are ignored on conversion).
- **control** — a control reply datagram (JSON). `result` frames whose
  `command` is `app_events` feed the events file; `result_chunk` frames are
  joined first. Anything else is ignored.
- **event** — compact JSON written by the host (`encodeNhrawEvent`, which
  keeps Python's int/float distinction), `{"type": ...}`:
  - `start` / `stop` — the recording switch (it is on from the header's start
    time). A stop with frames still queued drains as live; its timer fires at
    `stop + wait + 0.5 s` during conversion, so the host records nothing for it.
  - `shutdown` — the host quit mid-recording (`stop_reason` `server_stopped`).
  - `knowledge` — what the host knows about the device, for the meta:
    `device`, `status`, `nickname`, `group`, `relay_client_type`,
    `local_relay` (`"pocket"`), `local_relay_id`; any subset. Write one before
    the first frame; with `"status_update": true` it is also a full status
    arriving mid-recording (meta refresh, tracked changes).
  - `app_events_request` — `{"request_id", "since"}`: an `app_events` command
    the host sent, so the reply's gaps are judged as live.

A file too large to hold in memory is read in chunks with `NhrawStreamReader`
and converted record by record with `NhrawConverter` (same output as
`convertRaw`); `finish({ closeOpen: true })` ends a recording the app never
stopped (killed mid-recording) as a shutdown at the last record's time.

## Clocks during conversion

Wall time is each record's `rxEpochUs`; monotonic time is the same value in
ms. A live recorder fed the same frames with that clock writes identical
files (see test/recording/nhraw.test.ts).

Size: ~200 MB/hour at 112 sensors and 60 fps.
