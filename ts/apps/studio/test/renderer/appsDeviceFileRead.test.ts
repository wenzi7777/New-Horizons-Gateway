// @ts-nocheck -- ported JavaScript, kept close to the original so the two stay comparable.
// Ported from the Desktop's frontend/tests/deviceFileRead.test.mjs.
import assert from 'node:assert/strict';
import { test } from 'vitest';

import * as lib from '../../src/renderer/areas/apps/lib/deviceFileTransfer';


// A runner that answers file_read_begin with `size` and every chunk with
// `chunk(offset)`, counting how many chunks were asked for.
function runner(size, chunk) {
  const calls = { chunks: 0 };
  const run = async (payload) => {
    if (payload.command === "file_read_begin") return { result: { status: "ok", size } };
    calls.chunks += 1;
    if (calls.chunks > 50) throw new Error("runaway loop");
    return { result: chunk(payload.offset) };
  };
  return { run, calls };
}

test("a failing chunk stops the read instead of re-sending it", async () => {
  const { run, calls } = runner(3812, () => ({ status: "error", ok: false, error: "file_read_failed" }));
  await assert.rejects(lib.readDeviceFile(run, { path: "device.log" }), /file_read_failed/);
  assert.equal(calls.chunks, 1);
});

test("a chunk that times out stops the read", async () => {
  const { run } = runner(3812, () => null);
  await assert.rejects(lib.readDeviceFile(run, { path: "device.log" }), /no_response/);
});

test("a chunk that does not advance stops the read", async () => {
  const { run } = runner(3812, (offset) => ({ status: "ok", data: "00", next_offset: offset, has_more: true }));
  await assert.rejects(lib.readDeviceFile(run, { path: "device.log" }), /file_read_stalled/);
});

test("a good read still assembles the file", async () => {
  const { run } = runner(4, (offset) => ({
    status: "ok", data: offset === 0 ? "0102" : "0304", next_offset: offset + 2, has_more: offset === 0,
  }));
  const bytes = await lib.readDeviceFile(run, { path: "x.bin", chunkBytes: 2 });
  assert.deepEqual([...bytes], [1, 2, 3, 4]);
});

test("readFailure treats a missing reply as a failure", () => {
  assert.equal(lib.readFailure(null), "no_response");
  assert.equal(lib.readFailure({ status: "ok" }), null);
  assert.equal(lib.readFailure({ ok: false, error: "file_read_failed" }), "file_read_failed");
});
