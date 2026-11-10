// Ported from New-Horizons-Desktop/frontend/tests/calibrationFlow.test.mjs.
// @ts-nocheck -- verbatim port; fixtures are deliberately loose JSON.
import { strict as assert } from "node:assert";
import { test } from "vitest";

import {
  calibrationErrorKey,
  calibrationSnapshotKey,
  canSaveCalibration,
  chooseCalibrationState,
  getCalibrationStep,
  isFullCalibrationStatus,
  parseCalibrationState,
  saturatingSensorReports,
  sensorPointStatuses,
  unfittedSensorReports,
  zeroBlockedReason,
} from "../../src/renderer/areas/calibration/calibrationFlow";

function status(overrides = {}) {
  return {
    enabled: false,
    mode_active: true,
    session_active: false,
    complete: false,
    tare_complete: false,
    tare_enabled: false,
    output_mode: "raw",
    tare: { captured_points: 0, total_points: 16, missing_points: 16, complete: false, source: "saved" },
    draft_tare: { captured_points: 0, total_points: 16, missing_points: 16, complete: false, source: "draft" },
    levels: [],
    draft_levels: [],
    metadata: {},
    ...overrides,
  };
}

const completeTare = { captured_points: 16, total_points: 16, missing_points: 0, complete: true, source: "draft" };

test("a command reply wins over the snapshot it was taken against", () => {
  // The bug: the page adopted the begin reply, then an effect put the older
  // snapshot (session_active: false) back until the page was reloaded.
  const snapshot = { ...status() };
  const override = {
    state: parseCalibrationState(status({ session_active: true })),
    snapshotKey: calibrationSnapshotKey(snapshot),
  };
  assert.equal(chooseCalibrationState({ ...snapshot }, override).session_active, true);
});

test("a newer snapshot replaces the reply", () => {
  const snapshot = status();
  const override = {
    state: parseCalibrationState(status({ session_active: true })),
    snapshotKey: calibrationSnapshotKey(snapshot),
  };
  const newer = status({ session_active: false, enabled: true, complete: true });
  const chosen = chooseCalibrationState(newer, override);
  assert.equal(chosen.session_active, false);
  assert.equal(chosen.enabled, true);
});

test("the snapshot is used when there is no reply", () => {
  assert.equal(chooseCalibrationState(status({ session_active: true }), null).session_active, true);
  assert.equal(chooseCalibrationState({}, null).session_active, false);
});

test("reads a status nested under calibration or at the top level", () => {
  assert.equal(parseCalibrationState({ calibration: status({ enabled: true }) }).enabled, true);
  assert.equal(parseCalibrationState(status({ enabled: true })).enabled, true);
});

test("only a full calibration status counts as one", () => {
  assert.equal(isFullCalibrationStatus(status()), true);
  // capture/dump replies
  assert.equal(isFullCalibrationStatus({ total_points: 16, saved: null, draft: null, session_active: true }), false);
  assert.equal(isFullCalibrationStatus(null), false);
});

test("output mode is derived for firmware that does not report it", () => {
  const legacy = status();
  delete legacy.output_mode;
  delete legacy.tare_enabled;
  assert.equal(parseCalibrationState(legacy).output_mode, "raw");
  assert.equal(parseCalibrationState(legacy).output_mode_reported, false);
  assert.equal(parseCalibrationState({ ...legacy, enabled: true, complete: true }).output_mode, "calibrated");
  assert.equal(parseCalibrationState(status({ output_mode: "tared" })).output_mode, "tared");
  assert.equal(parseCalibrationState(status({ output_mode: "tared" })).output_mode_reported, true);
});

test("the flow is not started, then baseline, then pressures", () => {
  assert.equal(getCalibrationStep({ sessionActive: false, draftTareComplete: false, baselineConfirmed: false }), "not_started");
  assert.equal(getCalibrationStep({ sessionActive: true, draftTareComplete: false, baselineConfirmed: false }), "baseline");
  // A draft copied from an existing profile already has a baseline, but it is
  // only used once the operator captures a new one or chooses to keep it.
  assert.equal(getCalibrationStep({ sessionActive: true, draftTareComplete: true, baselineConfirmed: false }), "baseline");
  assert.equal(getCalibrationStep({ sessionActive: true, draftTareComplete: true, baselineConfirmed: true }), "levels");
});

test("save needs a baseline and a fit for every sensor", () => {
  const fit = (fitted) => ({
    cells_total: 16, cells_fitted: fitted, complete: fitted === 16,
    failures: { no_tare: 0, too_few_points: 16 - fitted, singular: 0 },
    failed: fitted === 16 ? [] : [{ sensor_index: 3, reason: "too_few_points" }],
  });
  assert.equal(canSaveCalibration(parseCalibrationState(status({ session_active: true, draft_tare: completeTare }))), false);
  assert.equal(canSaveCalibration(parseCalibrationState(status({ session_active: true, draft_tare: completeTare, draft_fit: fit(15) }))), false);
  assert.equal(canSaveCalibration(parseCalibrationState(status({ session_active: true, draft_tare: completeTare, draft_fit: fit(16) }))), true);
  assert.equal(canSaveCalibration(parseCalibrationState(status({ session_active: false, draft_tare: completeTare, draft_fit: fit(16) }))), false);
  // Sensors fitted from their own captures need not share levels, so an
  // incomplete level does not block saving.
  const partial = { level: 10, reference: 10, captured_points: 3, total_points: 16, missing_points: 13, complete: false, source: "draft" };
  assert.equal(canSaveCalibration(parseCalibrationState(status({ session_active: true, draft_tare: completeTare, draft_levels: [partial], draft_fit: fit(16) }))), true);
});

test("fit summaries and settings are parsed", () => {
  const state = parseCalibrationState(status({
    fit: { cells_total: 16, cells_fitted: 14, complete: false, failures: { no_tare: 0, too_few_points: 1, singular: 1 },
      failed: [{ sensor_index: 2, reason: "too_few_points" }, { sensor_index: 9, reason: "singular" }] },
    fit_settings: { min_level: 3, min_points: 3, readout: [{ adc: 1, c1: 2.6657, c2: -9.447e-5, clip_mv: 3150 }] },
    levels: [{ level: 10, reference: 10.12, captured_points: 16, total_points: 16, missing_points: 0, complete: true, source: "saved" }],
  }));
  assert.equal(state.fit.cells_fitted, 14);
  assert.equal(state.fit.failures.singular, 1);
  assert.deepEqual(state.fit.failed.map((item) => item.sensor_index), [2, 9]);
  assert.equal(state.draft_fit, null);
  assert.equal(state.fit_settings.readout[0].c2, -9.447e-5);
  assert.equal(state.levels[0].reference, 10.12);
});

test("zero is blocked offline and during a calibration only", () => {
  assert.equal(zeroBlockedReason(false, parseCalibrationState(status())), "device_offline");
  assert.equal(zeroBlockedReason(true, parseCalibrationState(status({ session_active: true }))), "session_active");
  // No maintenance mode needed.
  assert.equal(zeroBlockedReason(true, parseCalibrationState(status({ mode_active: false }))), null);
});

test("error codes map to readable messages", () => {
  assert.equal(calibrationErrorKey("calibration_tare_required"), "calErrorTareRequired");
  assert.equal(calibrationErrorKey("no_response"), "calErrorNoResponse");
  assert.equal(calibrationErrorKey(""), "calErrorNoResponse");
  assert.equal(calibrationErrorKey("something_else"), "calErrorGeneric");
});

test("relay failures get their own message instead of the raw code", () => {
  assert.equal(calibrationErrorKey("command_delivery_timeout"), "calErrorReplyTimeout");
  assert.equal(calibrationErrorKey("result_page_timeout"), "calErrorReplyTimeout");
  assert.equal(calibrationErrorKey("response_too_large"), "calErrorReplyTooLarge");
  assert.equal(calibrationErrorKey("result_page_expired"), "calErrorReplyTooLarge");
  assert.equal(calibrationErrorKey("command_too_large"), "calErrorReplyTooLarge");
});

test("newer firmware allows saving with some sensors unfitted", () => {
  const partialFit = (fitted) => ({
    cells_total: 16, cells_fitted: fitted, complete: fitted === 16, partial_save: true,
    failures: { no_tare: 0, too_few_points: 16 - fitted, singular: 0 }, failed: [],
  });
  assert.equal(canSaveCalibration(parseCalibrationState(status({ session_active: true, draft_tare: completeTare, draft_fit: partialFit(15) }))), true);
  // Nothing fitted at all is still refused, as the firmware does.
  assert.equal(canSaveCalibration(parseCalibrationState(status({ session_active: true, draft_tare: completeTare, draft_fit: partialFit(0) }))), false);
});

test("per-level point statuses explain each unfitted sensor", () => {
  // 3 sensors x 3 levels (43.3, 86.7, 120): P0 fine, P1 saturates at 120,
  // P2 no response at 43.3 and saturated at 120; P0 also clipped nowhere.
  const state = parseCalibrationState(status({
    session_active: true,
    draft_fit: {
      cells_total: 3, cells_fitted: 1, complete: false, partial_save: true,
      failures: { no_tare: 0, too_few_points: 2, singular: 0 }, failed: [],
      point_levels: [43.3, 86.7, 120],
      points: "uuu" + "uus" + "nus",
    },
  }));
  const fit = state.draft_fit;
  assert.equal(sensorPointStatuses(fit, 1).get(120), "saturated");
  assert.equal(sensorPointStatuses(fit, 2).get(43.3), "no_response");
  assert.equal(sensorPointStatuses(fit, 0).get(86.7), "used");
  assert.equal(sensorPointStatuses(fit, 9).size, 0);

  const reports = unfittedSensorReports(fit, 3);
  assert.deepEqual(reports.map((item) => item.sensor_index), [1, 2]);
  assert.deepEqual(reports[0], { sensor_index: 1, usable: 2, saturated: [120], no_response: [], saturates_from: 120 });
  assert.deepEqual(reports[1].no_response, [43.3]);
  assert.equal(reports[1].usable, 1);
});

test("fitted sensors that clip somewhere are reported as saturating", () => {
  const state = parseCalibrationState(status({
    session_active: true,
    draft_fit: {
      cells_total: 2, cells_fitted: 2, complete: true, partial_save: true,
      failures: { no_tare: 0, too_few_points: 0, singular: 0 }, failed: [],
      point_levels: [10, 20, 30, 40],
      points: "uuuu" + "uuus",
    },
  }));
  const saturating = saturatingSensorReports(state.draft_fit, 3);
  assert.deepEqual(saturating.map((item) => [item.sensor_index, item.saturates_from]), [[1, 40]]);
});

test("older firmware reports no point statuses", () => {
  const state = parseCalibrationState(status({
    session_active: true,
    draft_fit: { cells_total: 16, cells_fitted: 15, complete: false, failures: { no_tare: 0, too_few_points: 1, singular: 0 }, failed: [] },
  }));
  assert.equal(state.draft_fit.partial_save, false);
  assert.equal(state.draft_fit.points, "");
  assert.deepEqual(unfittedSensorReports(state.draft_fit, 3), []);
});

test("studio's own host timeout reads as a reply timeout", () => {
  assert.equal(calibrationErrorKey("command_timeout"), "calErrorReplyTimeout");
});
