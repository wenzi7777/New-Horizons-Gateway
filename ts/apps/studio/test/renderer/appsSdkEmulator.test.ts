// @ts-nocheck -- ported JavaScript, kept close to the original so the two stay comparable.
// Ported from the Desktop's frontend/tests/sdkEmulator.test.mjs (node:test + Vite SSR -> vitest).
import assert from 'node:assert/strict';
import { test } from 'vitest';

import * as emu from '../../src/renderer/areas/apps/lib/sdkEmulator';
import * as sdk from '../../src/renderer/areas/apps/sdk/lib/index.mjs';

const modules = Promise.resolve({ emu, sdk });


const HEADER = 'app demo {\n  name "Demo"\n  version 1.0.0\n  author me\n  summary "x"\n}\n';

async function compile(body) {
  const { sdk } = await modules;
  return sdk.compileSource(HEADER + body).package;
}

function frames(values, msStep = 16) {
  return values.map((v, i) => ({ seq: 100 + i, timestampMs: i * msStep, values: [v], rows: 1, cols: 1 }));
}



test("frames the browser never received are counted from frame_seq gaps", async () => {
  const { emu } = await modules;
  const gaps = new emu.SeqGapTracker();
  for (const seq of [10, 11, 13, 16, 17]) gaps.observe(seq);
  assert.equal(gaps.received, 5);
  assert.equal(gaps.missed, 3);
  assert.equal(gaps.coverage, 5 / 8);
});

test("a device reboot is not counted as a gap", async () => {
  const { emu } = await modules;
  const gaps = new emu.SeqGapTracker();
  for (const seq of [5000, 5001, 3, 4]) gaps.observe(seq);
  assert.equal(gaps.missed, 0);
});

test("the frame counter wrapping past uint32 is not a gap either", async () => {
  const { emu } = await modules;
  const gaps = new emu.SeqGapTracker();
  for (const seq of [2 ** 32 - 2, 2 ** 32 - 1, 0, 1]) gaps.observe(seq);
  assert.equal(gaps.missed, 0);
});

test("seeking backwards replays from the start, so debounce state is right", async () => {
  // Stepping back by undoing is impossible: the debounce timer IS the history.
  const { emu } = await modules;
  const pkg = await compile("signal a = total()\nevent hit when a > 10 for 50ms\n");
  const run = frames([0, 20, 20, 20, 20, 20, 0, 0]);
  const cursor = new emu.RecordingCursor(pkg, run);
  cursor.seek(7);
  const afterRun = cursor.simulator.events.map((e) => e.detail);
  cursor.seek(2);
  assert.equal(cursor.position, 2);
  assert.deepEqual(cursor.simulator.events, [], "only 32 ms held by frame 2: nothing may have fired yet");
  cursor.seek(7);
  assert.deepEqual(cursor.simulator.events.map((e) => e.detail), afterRun);
});

test("seek returns the events of the frame it lands on", async () => {
  const { emu } = await modules;
  const pkg = await compile("signal a = total()\nevent hit when a > 10\n");
  const cursor = new emu.RecordingCursor(pkg, frames([0, 20, 20, 0]));
  assert.deepEqual(cursor.seek(1).map((e) => e.detail), ["rise"]);
  assert.deepEqual(cursor.seek(2), []);
  assert.deepEqual(cursor.seek(3).map((e) => e.detail), ["fall"]);
});

test("injected budget pressure survives a replay", async () => {
  const { emu } = await modules;
  const pkg = await compile("signal load = budget_load()\ngate (load < 0.9) {\n  signal p = peak()\n  event spike when p > 10\n}\n");
  const cursor = new emu.RecordingCursor(pkg, frames([50, 50, 50]));
  cursor.setBudget(1.5, 1);
  cursor.seek(2);
  cursor.seek(0);
  assert.deepEqual(cursor.simulator.events.map((e) => e.event), ["degraded"]);
});

test("the editor marks the statement whose event fired", async () => {
  const { emu, sdk } = await modules;
  const { package: pkg, report } = sdk.compileSource(`${HEADER}signal a = total()\nevent hit when a > 10\n`);
  const events = [{ seq: 1, frameSeq: 1, timestampMs: 0, app: "x", event: "hit", detail: "rise", value: null }];
  assert.deepEqual([...emu.linesForEvents(pkg, report.nodeLines, events)], [8]);
  assert.deepEqual([...emu.linesForEvents(pkg, report.nodeLines, [])], []);
});

test("a recording's sidecar is found by name and kept out of the file list", async () => {
  const { emu } = await modules;
  assert.equal(emu.sidecarPathFor("NH-1/20260923/143000.csv"), "NH-1/20260923/143000.events.csv");
  assert.equal(emu.isSidecar("143000.events.csv"), true);
  assert.equal(emu.isSidecar("143000.csv"), false);
});

test("a button press in a recording survives scrubbing back past it", async () => {
  // Stepping backwards replays from the start; a press that was only sent to
  // the simulator would be lost the first time that happened.
  const { emu } = await modules;
  const pkg = await compile('show 0 "n" counter(button())\n');
  const run = frames([0, 0, 0, 0, 0]);
  const cursor = new emu.RecordingCursor(pkg, run, new Set([1, 3]));
  cursor.seek(4);
  assert.equal(cursor.simulator.oledRows()[0].value, 2);
  cursor.seek(2);
  assert.equal(cursor.simulator.oledRows()[0].value, 1);
  cursor.seek(4);
  assert.equal(cursor.simulator.oledRows()[0].value, 2);
});

test("the whole-run timeline sees the same presses", async () => {
  const { emu } = await modules;
  const pkg = await compile("event pressed when counter(button()) > 0.5\n");
  assert.deepEqual(emu.simulateAll(pkg, frames([0, 0, 0]), new Set([2])).map((e) => e.frameSeq), [102]);
  assert.deepEqual(emu.simulateAll(pkg, frames([0, 0, 0])), []);
});

test("generated patterns press and release on their schedule", async () => {
  const { emu } = await modules;
  // A tap: pressed at 125 ms, free again by 500 ms, pressed again next cycle.
  assert.ok(emu.patternBlob("tap", 125, 15, 15).amp > 0.6);
  assert.equal(emu.patternBlob("tap", 500, 15, 15), null);
  assert.ok(emu.patternBlob("tap", 2125, 15, 15).amp > 0.6);
  // A swipe crosses the columns left to right.
  const early = emu.patternBlob("swipe", 300, 5, 7);
  const late = emu.patternBlob("swipe", 1700, 5, 7);
  assert.ok(early.col < late.col);
  assert.equal(emu.patternBlob("none", 100, 5, 5), null);
});

test("a synthetic feed makes frames of its shape, within full scale", async () => {
  const { emu, sdk } = await modules;
  const feed = new emu.SyntheticFeed(3, 4, { pattern: "ramp", noise: 1, seed: 7 });
  const first = feed.frame(0);
  assert.equal(first.values.length, 12);
  assert.deepEqual([first.rows, first.cols, first.seq], [3, 4, 0]);
  const peak = feed.frame(3999);
  assert.equal(peak.seq, 1);
  for (const value of peak.values) assert.ok(value >= 0 && value <= sdk.PRESSURE_FULL_SCALE);
  assert.ok(Math.max(...peak.values) > Math.max(...first.values));
  // Seeded: the same feed from the start makes the same noise.
  const again = new emu.SyntheticFeed(3, 4, { pattern: "ramp", noise: 1, seed: 7 });
  assert.deepEqual([...again.frame(0).values], [...first.values]);
});

test("a mouse press builds up while held and fades after release", async () => {
  const { emu } = await modules;
  const feed = new emu.SyntheticFeed(5, 5, { pattern: "none", noise: 0 });
  assert.equal(Math.max(...feed.frame(0).values), 0);
  feed.press({ row: 1, col: 3 }, 0);
  const soon = feed.frame(100).values[1 * 5 + 3];
  const later = feed.frame(600).values[1 * 5 + 3];
  assert.ok(soon > 0 && later > soon);
  // The press is centred where it was made.
  assert.ok(later > feed.frame(600).values[4 * 5 + 0]);
  feed.press(null, 600);
  assert.ok(feed.frame(700).values[1 * 5 + 3] > 0);
  assert.equal(Math.max(...feed.frame(900).values), 0);
});

test("a generated frame runs through the simulator", async () => {
  const { emu, sdk } = await modules;
  const pkg = await compile("signal a = total()\nevent pressed when a > 100\n");
  const sim = new sdk.Simulator(pkg);
  const feed = new emu.SyntheticFeed(4, 4, { pattern: "hold", noise: 0 });
  const period = 1000 / emu.SYNTH_FPS;
  for (let t = 0; t < 2000; t += period) sim.step(feed.frame(t));
  assert.ok(sim.events.some((event) => event.event === "pressed"));
});


test('a Studio live frame becomes a simulator frame numbered by the emulator', async () => {
  const { emu } = await modules;
  const frame = emu.frameFromLiveFrame({ values: [1, 2, 3, 4], rows: 2, cols: 2, timestampMs: 5000.7 }, 77);
  assert.ok(frame);
  assert.deepEqual([frame.seq, frame.timestampMs, frame.rows, frame.cols], [77, 5000, 2, 2]);
  assert.deepEqual([...frame.values], [1, 2, 3, 4]);
  // A size that disagrees with the shape is one row, never reshaped.
  const odd = emu.frameFromLiveFrame({ values: [1, 2, 3], rows: 2, cols: 2, timestampMs: 1 }, 9);
  assert.deepEqual([odd?.rows, odd?.cols, odd?.seq], [1, 3, 9]);
  assert.equal(emu.frameFromLiveFrame({ values: [], rows: 2, cols: 2, timestampMs: 1 }, 0), null);
});
