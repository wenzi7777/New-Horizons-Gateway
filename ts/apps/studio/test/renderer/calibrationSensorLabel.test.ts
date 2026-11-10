// Ported from New-Horizons-Desktop/frontend/tests/sensorLabel.test.mjs.
import { strict as assert } from "node:assert";
import { test } from "vitest";

import { calibrationSensorLabel, calibrationToStreamIndex, streamSensorLabel } from "../../src/renderer/areas/calibration/sensorLabel";

test("labels match the CSV export: row-major, from P1", () => {
  assert.equal(streamSensorLabel(0), "P1");
  assert.equal(streamSensorLabel(44), "P45");
});

test("calibration's column-major index maps to the same physical sensor", () => {
  // 9 rows x 5 cols, as on the glove that surfaced this: calibration's
  // P27..P35 (one whole select column) are CSV P4, P9, ..., P44.
  const labels = [27, 28, 29, 30, 31, 32, 33, 34, 35].map((index) => calibrationSensorLabel(index, 9, 5));
  assert.deepEqual(labels, ["P4", "P9", "P14", "P19", "P24", "P29", "P34", "P39", "P44"]);
  // Every calibration index lands on a distinct stream index.
  const seen = new Set();
  for (let i = 0; i < 45; i += 1) seen.add(calibrationToStreamIndex(i, 9, 5));
  assert.equal(seen.size, 45);
  assert.equal(calibrationToStreamIndex(0, 9, 5), 0);
  assert.equal(calibrationToStreamIndex(1, 9, 5), 5);
});
