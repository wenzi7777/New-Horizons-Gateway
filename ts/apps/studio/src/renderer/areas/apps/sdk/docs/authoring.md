# Writing an NHOS app

## What an app is

An app is a TypeScript file, `app.ts`, that the App SDK compiles to bytecode
for the device's app VM ([vm.md](vm.md)). It reacts to events -- a frame from
the pressure matrix, a tick, a press of the action button, a message from
another app -- and reads sensors, keeps state, and shows or logs what it finds.

```ts
/// <reference path="../../sdk/types/nhos.d.ts" />

export const manifest = {
  id: "taps",
  name: "Tap Counter",
  version: "3.0.0",
  author: "wenzi7777",
  summary: "Counts presses and times each hold; button resets.",
  category: "rehab",
  icon: "touch",
} as const;

const press = new Debounce(20);           // state: created once, at the top level
const taps = new Counter({ persist: true });
const hold = new Duration();

on("frame", () => {
  const down = press.update(matrix.activeCells(50) > 0.5);
  taps.update(press.rose, button.pressed());
  const held = hold.update(down);
  if (press.fell) emit("hold_ms", held);
  strip.pixel(0, Color.Blue, down);
  oled.text(0, "Taps", taps.value);
  oled.text(1, "Hold ms", held);
});
```

Every `app.ts` is a valid TypeScript file. [`sdk/types/nhos.d.ts`](../sdk/types/nhos.d.ts)
declares the whole API, so an editor (VS Code, or the Desktop's App Studio)
completes it and type-checks it; the reference comment at the top points the
editor at it. The compiler accepts a subset of TypeScript and tells you, with a
line and column, when you step outside it.

The device runs every handler to completion when it can, and suspends it when
its share of the CPU is spent (see [Budgets](#budgets)), so a loop cannot stall
the scan. Scanning always comes first.

## The language

### Values

Numbers are 32-bit floats on the device -- whole numbers are exact up to
16,777,216 -- and booleans are true/false. Dividing by zero, and `%` by zero,
give 0 rather than Infinity or NaN. `&`, `|`, `^`, `<<` and `>>` work on
unsigned 32-bit integers.

Strings exist only as constant names and labels: an event name, an OLED label,
a store key or file, a message topic.

### At the top level

| Form | What it is |
|---|---|
| `export const manifest = { ... }` | The app's id, name, version, author, summary and optional category, icon and `budget_us`. Capabilities and `min_os` are computed; do not write them. |
| `let x = 0;` / `const k = 2.5;` | A global number or boolean, initialised to a constant. Globals keep their value between runs. To compute a starting value, assign it in `on("start", ...)`. |
| `const buf = new Float32Array(16);` | A fixed array of numbers, zeroed at start. |
| `const t = new Threshold(400, 50);` | A stateful object ([below](#stateful-objects)). |
| `const heel = new Region({ rows: [8, 14], cols: [0, 14] });` | A rectangle of the matrix. |
| `function f(a: number): number { ... }` | A function. Not recursive, directly or through others. |
| `on("frame", () => { ... })` | A handler. One per event. |

### Inside functions and handlers

`let`/`const`, `if`/`else`, `while`, `for (let i = 0; i < n; i++)`, `break`,
`continue`, `return`, `? :`, `&&`/`||` (which short-circuit), `!`, `=`, `+=`
and the other compound assignments, `++`/`--`, and calls. Locals start at
zero on every run; a block's `let` is scoped to the block.

Not supported: closures over locals, objects other than the manifest and the
classes below, dynamic arrays, strings as values, `any`, classes of your own.

### Events

```ts
on("start",  () => { ... });   // once, when the app starts
on("frame",  () => { ... });   // every frame the scanner produces
on("tick",   () => { ... });   // 10 times a second, always
on("idle",   () => { ... });   // 10 times a second, only while no frames arrive
on("button", () => { ... });   // each short press of the action button
on("stop",   () => { ... });   // once, when the app is stopped or removed
on("message", "heel", (value) => { ... });   // app.publish("heel", v) from another app
```

A handler may also be a named function: `on("frame", step)`.

`tick` and `idle` need the `tick` capability (it is derived for you). While an
`idle` or `tick` handler runs without a frame, every matrix reading holds the
value the last frame left: `matrix.total()` in an idle handler is the last
frame's total.

`button.pressed()` is true for one run per press, from the `frame` (or
`tick`/`idle`) handler that sees it. An app with `on("button")` gets each press
there instead.

### Reading the sensors

| Call | Reads | Unit | Capability |
|---|---|---|---|
| `matrix.total()`, `matrix.peak()` | sum / largest cell | raw | `read_matrix` |
| `matrix.activeCells(level)` | cells at or above a constant level | count | `read_matrix` |
| `matrix.argMax()` | index of the largest cell, `row * cols + col` | | `read_matrix` |
| `matrix.rowCentroid()`, `matrix.colCentroid()` | centre of force (cells >= 50) | fractional index | `read_matrix` |
| `matrix.cell(r, c)` | one cell; out of range stops the app | raw | `read_matrix` |
| `matrix.rows`, `matrix.cols` | the frame's shape | | `read_matrix` |
| `region.sum()`, `.peak()`, `.active(level)`, `.rowCentroid()`, `.colCentroid()` | the same, over a `Region` | | `read_matrix` |
| `imu.ax`, `.ay`, `.az` | acceleration | g | `read_imu` |
| `imu.gx`, `.gy`, `.gz` | rotation | deg/s | `read_imu` |
| `imu.accMag`, `imu.gyroMag` | their magnitudes | g, deg/s | `read_imu` |
| `imu.pitch`, `imu.roll` | tilt from gravity, in the board's axes | degrees | `read_imu` |
| `mag.x`, `.y`, `.z`, `.strength` | magnetic field | microtesla | `read_mag` |
| `mag.heading` | its angle in the board's x-y plane, 0-360 | degrees | `read_mag` |
| `battery()` | fuel gauge charge, -1 without a reading | percent | `power` |
| `linked()` | a relay or Hub to stream to | boolean | `link` |
| `uptime()`, `now()`, `frameSeq()` | seconds since boot; ms and frame sequence, modulo 2^24 | | |
| `budget.load`, `budget.graceLeft` | the app's load and grace frames left | | |

Each sensor reads the sample streamed with the frame and holds its last value
when a frame carries none; a board without the sensor reads 0. `pitch`/`roll`
are tilt only while the board is not accelerating, and `heading` is not
tilt-compensated.

`Features` computes every per-frame feature in one pass over the matrix:
`const f = new Features(); ... f.update(); f.peak01; f.inContact; ...`.

### Regions

```ts
const heel = new Region({ rows: [8, 14], cols: [0, 14] });               // cells, inclusive
const left = new Region({ rows: [0, 100], cols: [0, 50], percent: true }); // percent of each frame's matrix
```

A percent region is resolved against each frame's own matrix, so one package
covers a 15x15 mat and a 5x7 sensor alike. The first row is `floor(a% of
rows)` and the last `ceil(b% of rows) - 1`, never empty: on an odd count, a
row a boundary splits belongs to both sides, which keeps a left/right split
symmetric.

### Stateful objects

Created at the top level, each owns a fixed piece of the app's memory.
`update(...)` feeds it and returns its value; `.value` reads it without
feeding.

| Class | Does |
|---|---|
| `Threshold(on, hysteresis = 0)` | true at `on`, false below `on - hysteresis`; `.rose`/`.fell` on the update that changed it |
| `Debounce(ms)` | follows its boolean input once it has held for `ms` (up to 65535) |
| `Edge()` | `.rose`/`.fell` of any boolean |
| `Mean(n)`, `MaxHold(n)`, `Integrate(n)` | mean / largest / sum of the last `n` updates (n <= 128) |
| `Delta(initial = 0)` | value minus the previous update's |
| `Counter({ persist })` | counts rising edges; `update(input, reset)` zeroes it on `reset`'s rise |
| `Duration()` | milliseconds its input has been true |
| `Interval()` | milliseconds between its input's last two rises (0 until the second) |
| `PeakSince()` | `update(value, reset)`: the largest value since `reset` last rose |

`Mean`, `MaxHold` and `Integrate` count updates, not time, so `new Mean(30)`
spans half a second while streaming at 60 Hz. `Duration` and `Interval` keep
a timestamp instead and have no such limit:

```ts
const loaded = new Threshold(300);
const time = new Duration();
on("frame", () => {
  const minutes = time.update(loaded.update(matrix.total())) / 60000;
  event("overdue", minutes > 20);
});
```

### Output

| Call | Shows | Capability |
|---|---|---|
| `emit(name, value)` | logs a value event | `emit_event` |
| `event(name, on)` | logs `name` rise / fall whenever `on` changes | `emit_event` |
| `log(label, value)` | a debug line in the device log | |
| `led.set(color, on)` | the status LED shows `color` while `on` | `drive_led` |
| `strip.pixel(i, color, on)` | external strip pixel `i` (0-8, constant) | `drive_ext_led` |
| `strip.meter(value, lo, hi)` | the strip as a bar, green to red | `drive_ext_led` |
| `oled.text(row, label, value, digits = 0)` | an OLED row: label, then the value right-aligned | `display` |
| `oled.bar(row, label, value, lo, hi)` | an OLED row: label, then a bar | `display` |

Colours are `Color.Red`, `Green`, `Blue`, `White` and `Off`. Event names are
up to 23 characters; OLED labels up to 10 printable ASCII characters, rows 0
to 3, digits 0 to 3.

What an app draws is rebuilt on every frame run: a row, pixel or LED the run
did not reach goes dark rather than freezing, so a page switched by `if` is
blank where it drew nothing.

**The OLED** (SSD1306 128x32 on the exposed I2C bus, v1.0.F and later) shows
an app's rows only while the device's OLED page is set to `app`. With several
apps running, each row comes from the lowest-numbered slot that drew it.

**The status LED** is the system's first: an app's colour replaces only the
healthy, online pattern, and anything the system is telling the operator
(booting, errors, OTA, a lost link, ...) shows instead.

**The strip** (v1.0.F 3 pixels, v1.5.F and later 9) is taken over from the
device's preset while the app runs and handed back when it stops. Pixels draw
over the meter. A pixel past the board's own count is accepted and never shown,
so one package runs on every board.

## Storage, messages, device control and I/O (v2.1.0)

These need firmware v2.1.0. Those marked **[ask]** are *dangerous
capabilities*: the Desktop and NH Studio list them when the app is installed
and install it only once the operator agrees, and the device itself refuses an
install that did not grant them.

### `store` [ask: `storage`]

```ts
store.set("best", 42);              // a named number kept across reboots
const best = store.get("best");     // 0 if never set; up to 16 names per app
store.append("log", a, b, c, d);    // appends "ms,a,b,c,d" to /appdata/<app>/log.csv
store.clear("log");                 // deletes the file
```

Each app has 16 KB of files. `append` returns false once they are full (the
device then logs `store_full`); a missing value is an empty column. Rows are
collected in a 256-byte buffer per app and written every 10 seconds, when the
buffer fills, and when the app stops -- a power cut can lose the last few
seconds. File names are `a-z`, `0-9` and `_`, up to 8 characters. Values are
written every 30 seconds and when the app stops. Uninstalling the app deletes
both.

### Messages (`app_ipc`)

```ts
app.publish("heel", force);                          // in one app
on("message", "heel", (value) => { ... });           // in another
```

A message reaches every other running app with a handler for its topic, and
runs that handler before the next event. Each app queues 4 messages; more are
dropped and counted.

### `device` [ask: `device_config`, `device_stream`]

```ts
device.configSet("scan.target_fps", 30);   // false if out of range, or again within a second
device.configGet("filter.alpha");
device.stream(false);                      // pause streaming; resumed when the app stops
```

The settings an app may change: `scan.target_fps`, `scan.send_every_n_frames`,
`filter.enabled`, `filter.median`, `filter.alpha`, `imu.enabled`. A change is
never saved, goes through the same checks as the `set_config` command, and is
undone when the app stops, faults or is removed.

### `i2c` and `uart` [ask: `io_i2c`, `io_uart`]

Only on v1.5.F and v2.0.F; the device refuses to install an app with these
on any other board.

```ts
const buf = new Float32Array(6);
const id = i2c.read8(0x48, 0x0f);          // -1 when nothing answers
i2c.write8(0x48, 0x20, 0x07);
i2c.read(0x48, 0x28, buf, 6);              // bytes into buf[0..6)
uart.open(115200);                         // UART0: TX FPC1.17, RX FPC1.16
uart.write(0x41);
while (uart.available() > 0) emit("rx", uart.read());
```

I2C is the exposed bus (SDA FPC2.16, SCL FPC2.17), 7-bit addresses 0x08 to
0x77 except the board's own chips (0x14, 0x36, 0x3C, 0x3D, 0x41, 0x60, 0x68,
0x6A), at most 32 bytes a transfer and a 5 ms timeout; the time a transfer
takes counts toward the app's slice. UART0 runs at 1200 to 921600 baud with a
256-byte receive buffer, and is closed and its pins released when the app
stops.

## Hard limits

| Limit | Value |
|---|---|
| Package size | 8192 bytes |
| App id | `a-z`, `0-9`, `_`, starting with a letter, up to 15 characters |
| Code | 8192 bytes (in practice the package size limits it first) |
| Memory (arena: objects, globals, arrays) | 1536 floats, from the pool the four slots share |
| Stateful objects + globals | 32 |
| Functions and handlers | 32, calls at most 8 deep |
| Window length | 128 updates |
| Event name / OLED label | 23 / 10 characters |
| Time per frame, loop-free code | 1500 us, or the manifest's `budget_us` if lower |
| Stored files / values / write buffer | 16 KB / 16 / 256 B per app |
| Messages waiting | 4 per app |

The compiler reports how much of each an app uses.

## Budgets

An app's time budget is **not fixed**. The device divides a configurable share
of CPU among the apps that are actually running, so enabling a fourth app
shrinks the other three's allocation. Scanning always wins: if the scan loop
starts missing deadlines the apps' share is reduced automatically, and in the
limit every app is suspended.

For code without loops the compiler gives a worst case in microseconds, and an
app over its budget is refused at install. Code with a loop cannot be
estimated; it runs on *fuel* instead -- each instruction costs some, and when
the slice is spent the handler is suspended exactly where it was and resumed
on the next turn. A handler still running when the next frame arrives skips
that frame, and the skipped count is logged as `frames_skipped`. An app that
never finishes is stopped as `starved`.

Two states are distinct and must not be confused:

- **Killed** -- the app repeatedly exceeded its own allocation. That is the
  app's fault, and an operator has to acknowledge it with `app-revive`.
- **Suspended** -- the system needed the capacity. Not the app's fault, and it
  resumes on its own once the pressure clears.

An app may read `budget.load` and `budget.graceLeft` and do less when it is
close to its limit. This is a research data-collection device: a signal that
quietly changes fidelity because someone enabled another app puts a step in
the data that has nothing to do with the subject, so do it visibly -- emit an
event when you degrade.

## Faults

An array index out of range, `matrix.cell` outside the matrix, or a bad
argument to a system call stops the app with a reason (`array_bounds`,
`bad_syscall_arg`) shown in the Desktop's Apps panel. A
constant index out of range is a compile error instead.

## Persisted counters

```ts
const steps = new Counter({ persist: true });
```

A persisted counter survives a reboot: the device writes it to NVS -- at most
every 30 seconds, outside the app's time allocation, and when the app stops --
and restores it when the app starts again. A new version of the package, or
uninstalling it, starts from zero; so does the counter's reset input. For
anything else that must survive, use `store`.

## Testing without a device

The Desktop's App Studio replays a recording, or a live device's stream,
through the app, and shows the OLED, the LEDs, every object's value and the
events as it goes. From the command line, `simulate` does the same against a
recorded sample CSV:

```
node sdk/bin/nhos.mjs simulate apps/heel_strike/app.ts session.csv \
    --rows 15 --cols 15 --events simulated.events.csv --compare session.events.csv
```

A recording's `Acc_*`, `Gyro_*` and `Mag_*` columns feed `imu` and `mag`. A
recording holds no button presses, so `--press 500,1800` presses the button at
those times (ms). It does not store the matrix shape, so pass `--rows`/`--cols`
for any board that is not square. `--events` writes the same `.events.csv`
shape the Desktop writes beside a recording; `--compare` lines the simulated
events up against the ones the device recorded, by `frame_seq`, and exits
non-zero if they differ.

From code, `VmSimulator` runs a package: `step(frame)`, `tick(ms)`,
`pressButton()`, `setBattery()`, `setLinked()`, `stop()`, and `persisted()` /
the `restore` option across a simulated reboot. A `SimDevice` holds the
simulated store, settings, stream state, I2C registers and a UART loopback; a
`SimBus` connects several simulators for messages.

The simulator computes in 32-bit float, as the ESP32 does, and runs the same
bytecode the device does: `sdk/test/vm-native.test.mjs` builds the firmware's
VM for the host and checks the two agree bit for bit on every library app and
on hundreds of random programs.

## Writing in VS Code

```
npx tsc -p sdk/types/tsconfig.json
```

type-checks every library app and example against `nhos.d.ts`. For your own
app, keep the reference comment at the top of `app.ts` pointing at a copy of
`nhos.d.ts`.
