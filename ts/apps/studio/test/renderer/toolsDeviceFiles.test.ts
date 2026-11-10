// @ts-nocheck -- ported from New-Horizons-Desktop/frontend/tests/deviceFileRead.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import * as lib from "../../src/renderer/areas/tools/lib/deviceFileTransfer";
import { storageSnapshotFromDevice, storageSnapshotFromResult } from "../../src/renderer/areas/tools/lib/storageStatus";
describe("deviceFileTransfer (Desktop tests)", () => {

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

it("a failing chunk stops the read instead of re-sending it", async () => {
  const { run, calls } = runner(3812, () => ({ status: "error", ok: false, error: "file_read_failed" }));
  await assert.rejects(lib.readDeviceFile(run, { path: "device.log" }), /file_read_failed/);
  assert.equal(calls.chunks, 1);
});

it("a chunk that times out stops the read", async () => {
  const { run } = runner(3812, () => null);
  await assert.rejects(lib.readDeviceFile(run, { path: "device.log" }), /no_response/);
});

it("a chunk that does not advance stops the read", async () => {
  const { run } = runner(3812, (offset) => ({ status: "ok", data: "00", next_offset: offset, has_more: true }));
  await assert.rejects(lib.readDeviceFile(run, { path: "device.log" }), /file_read_stalled/);
});

it("a good read still assembles the file", async () => {
  const { run } = runner(4, (offset) => ({
    status: "ok", data: offset === 0 ? "0102" : "0304", next_offset: offset + 2, has_more: offset === 0,
  }));
  const bytes = await lib.readDeviceFile(run, { path: "x.bin", chunkBytes: 2 });
  assert.deepEqual([...bytes], [1, 2, 3, 4]);
});

it("readFailure treats a missing reply as a failure", () => {
  assert.equal(lib.readFailure(null), "no_response");
  assert.equal(lib.readFailure({ status: "ok" }), null);
  assert.equal(lib.readFailure({ ok: false, error: "file_read_failed" }), "file_read_failed");
});
});

describe("deviceFileTransfer write", () => {
  it("writes in CHUNK_BYTES hex chunks between begin and finish", async () => {
    const sent = [];
    const run = async (payload) => { sent.push(payload); return { result: { status: "ok" } }; };
    const bytes = new Uint8Array(lib.CHUNK_BYTES * 2 + 5).map((_, i) => i & 0xff);
    await lib.writeDeviceFile(run, { path: "a.bin", bytes, sha256: "ab" });
    assert.deepEqual(sent.map((p) => p.command), ["file_write_begin", "file_write_chunk", "file_write_chunk", "file_write_chunk", "file_write_finish"]);
    assert.equal(sent[1].data, lib.bytesToHex(bytes.slice(0, lib.CHUNK_BYTES)));
    assert.equal(sent[4].sha256, "ab");
  });
  it("refuses a user path over MAX_USER_PATH before sending", async () => {
    let calls = 0;
    await assert.rejects(lib.writeDeviceFile(async () => { calls += 1; return { result: {} }; }, { path: "x".repeat(lib.MAX_USER_PATH + 1), bytes: new Uint8Array(1) }), /path_too_long/);
    assert.equal(calls, 0);
  });
  it("stops on a device error and on cancel", async () => {
    await assert.rejects(lib.writeDeviceFile(async () => ({ result: { status: "error", error: "no_space" } }), { path: "a", bytes: new Uint8Array(3) }), /no_space/);
    const abortRef = { current: true };
    await assert.rejects(lib.writeDeviceFile(async () => ({ result: {} }), { path: "a", bytes: new Uint8Array(3), abortRef }), /upload_cancelled/);
  });
  it("hex round-trips", () => {
    assert.deepEqual(Array.from(lib.hexToBytes(lib.bytesToHex(Uint8Array.from([0, 15, 255])))), [0, 15, 255]);
  });
});

describe("storageStatus", () => {
  it("reads direct and nested payloads", () => {
    const direct = storageSnapshotFromResult({ total_bytes: 100, used_bytes: 40, free_bytes: 60, categories: [{ scope: "user", bytes: 30 }, { scope: "logs", bytes: 0 }] });
    assert.equal(direct.hasPayload, true);
    assert.deepEqual([direct.totalBytes, direct.usedBytes, direct.freeBytes], [100, 40, 60]);
    assert.deepEqual(direct.categories, [{ scope: "user", bytes: 30 }]);
    assert.equal(storageSnapshotFromResult({ data: { total_bytes: 5 } }).totalBytes, 5);
    assert.equal(storageSnapshotFromResult({ storage: { used_bytes: 7 } }).usedBytes, 7);
    assert.equal(storageSnapshotFromResult({ storage_status: { free_bytes: 9 } }).freeBytes, 9);
    assert.equal(storageSnapshotFromResult(null).hasPayload, false);
    assert.equal(storageSnapshotFromResult({ total_bytes: "x" }).totalBytes, 0);
  });
  it("takes a device's last status, then a storage_status result", () => {
    assert.equal(storageSnapshotFromDevice({ last_status: { storage: { total_bytes: 1 } } }).totalBytes, 1);
    assert.equal(storageSnapshotFromDevice({ last_result: { command: "storage_status", total_bytes: 2 } }).totalBytes, 2);
    assert.equal(storageSnapshotFromDevice({ last_result: { command: "status", total_bytes: 2 } }).hasPayload, false);
    assert.equal(storageSnapshotFromDevice(null).hasPayload, false);
  });
});
