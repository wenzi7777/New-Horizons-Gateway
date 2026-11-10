// Ported from New-Horizons-Desktop/frontend/src/lib/calibrationFlow.ts (keep in step).
// Calibration state and the pressure-calibration flow, kept free of React so
// the rules can be tested directly.
//
// The device reports calibration in two places: the `calibration` block of
// its status (what the device snapshot carries), and the full calibration
// status most calibration_* commands answer with. A command reply is newer
// than the snapshot until the snapshot moves on, so the page shows the reply
// first -- that is what makes 'Start calibration' take effect without a
// reload.

export type CalibrationOutputMode = 'raw' | 'tared' | 'calibrated';

export type CalibrationCaptureSummary = {
  captured_points: number;
  total_points: number;
  missing_points: number;
  complete: boolean;
  source: string;
};

export type CalibrationSummary = CalibrationCaptureSummary & {
  // The nominal level that names it (and that dump/delete address).
  level: number;
  // The pressure actually applied, which the fit uses.
  reference: number;
};

// How far the per-sensor fit p = a + b*sqrt(x) + c*x got: the saved
// profile's, or what Save would produce from the current draft.
export type CalibrationFitSummary = {
  cells_total: number;
  cells_fitted: number;
  complete: boolean;
  failures: { no_tare: number; too_few_points: number; singular: number };
  // The first few sensors that could not be fitted.
  failed: { sensor_index: number; reason: string }[];
  // Firmware v1.12.0+: a profile can be saved with some sensors unfitted
  // (they read 0), so Save only needs one fitted sensor.
  partial_save: boolean;
  // Draft only, firmware v1.12.0+: why each captured reading was or was not
  // a fit point -- one character per level (in point_levels order) per
  // sensor, sensor after sensor. Empty when not reported.
  point_levels: number[];
  points: string;
};

export type CalibrationPointStatus = 'used' | 'not_captured' | 'below_min' | 'saturated' | 'no_response';

const POINT_STATUS_CODES: Record<string, CalibrationPointStatus> = {
  u: 'used',
  '-': 'not_captured',
  b: 'below_min',
  s: 'saturated',
  n: 'no_response',
};

// Level -> status for one sensor; empty when the firmware did not report.
export function sensorPointStatuses(fit: CalibrationFitSummary | null, sensorIndex: number): Map<number, CalibrationPointStatus> {
  const out = new Map<number, CalibrationPointStatus>();
  if (!fit || !fit.points || fit.point_levels.length === 0 || sensorIndex < 0) return out;
  const width = fit.point_levels.length;
  const row = fit.points.slice(sensorIndex * width, (sensorIndex + 1) * width);
  if (row.length !== width) return out;
  fit.point_levels.forEach((level, index) => {
    out.set(level, POINT_STATUS_CODES[row[index] ?? ''] ?? 'not_captured');
  });
  return out;
}

export type SensorFitReport = {
  sensor_index: number;
  usable: number;
  saturated: number[];
  no_response: number[];
  // The lowest level at which it clipped: the top of its usable range.
  saturates_from: number | null;
};

function reportFor(fit: CalibrationFitSummary, sensorIndex: number): SensorFitReport {
  const statuses = sensorPointStatuses(fit, sensorIndex);
  const saturated: number[] = [];
  const noResponse: number[] = [];
  let usable = 0;
  for (const [level, status] of statuses) {
    if (status === 'used') usable += 1;
    else if (status === 'saturated') saturated.push(level);
    else if (status === 'no_response') noResponse.push(level);
  }
  saturated.sort((a, b) => a - b);
  noResponse.sort((a, b) => a - b);
  return {
    sensor_index: sensorIndex,
    usable,
    saturated,
    no_response: noResponse,
    saturates_from: saturated[0] ?? null,
  };
}

// Sensors that cannot be fitted yet, with why: fewer usable levels than the
// model needs. Empty when the firmware did not report point statuses.
export function unfittedSensorReports(fit: CalibrationFitSummary | null, minPoints: number): SensorFitReport[] {
  if (!fit || !fit.points || fit.point_levels.length === 0) return [];
  const reports: SensorFitReport[] = [];
  for (let sensor = 0; sensor < fit.cells_total; sensor += 1) {
    const report = reportFor(fit, sensor);
    if (report.usable < minPoints) reports.push(report);
  }
  return reports;
}

// Fitted sensors that clipped at some level: their output is held at their
// highest usable level instead of extrapolating past it.
export function saturatingSensorReports(fit: CalibrationFitSummary | null, minPoints: number): SensorFitReport[] {
  if (!fit || !fit.points || fit.point_levels.length === 0) return [];
  const reports: SensorFitReport[] = [];
  for (let sensor = 0; sensor < fit.cells_total; sensor += 1) {
    const report = reportFor(fit, sensor);
    if (report.usable >= minPoints && report.saturated.length > 0) reports.push(report);
  }
  return reports;
}

export type CalibrationFitSettings = {
  min_level: number;
  min_points: number;
  readout: { adc: number; c1: number; c2: number; clip_mv: number }[];
};

export type CalibrationState = {
  enabled: boolean;
  mode_active: boolean;
  session_active: boolean;
  complete: boolean;
  tare_complete: boolean;
  // Firmware before v1.5.1 reports neither; `output_mode` is then derived.
  tare_enabled: boolean | null;
  output_mode: CalibrationOutputMode;
  output_mode_reported: boolean;
  tare: CalibrationCaptureSummary | null;
  draft_tare: CalibrationCaptureSummary | null;
  levels: CalibrationSummary[];
  draft_levels: CalibrationSummary[];
  fit: CalibrationFitSummary | null;
  draft_fit: CalibrationFitSummary | null;
  fit_settings: CalibrationFitSettings | null;
  metadata: Record<string, unknown>;
};

export type CalibrationStep = 'not_started' | 'baseline' | 'levels';

export type CalibrationFlowSnapshot = {
  sessionActive: boolean;
  draftTareComplete: boolean;
  // The operator captured (or chose to keep) the baseline in this session.
  baselineConfirmed: boolean;
};

export type CalibrationOverride = {
  state: CalibrationState;
  // The snapshot's calibration block when the reply arrived.
  snapshotKey: string;
};

const CALIBRATION_STATUS_KEYS = [
  'enabled',
  'mode_active',
  'session_active',
  'complete',
  'tare_complete',
  'tare_enabled',
  'output_mode',
  'tare',
  'draft_tare',
  'levels',
  'draft_levels',
  'fit',
  'draft_fit',
  'fit_settings',
  'metadata',
];

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown, fallback: number) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function calibrationSource(value: unknown) {
  const direct = recordValue(value);
  const nested = recordValue(direct.calibration);
  if (Object.keys(nested).length > 0) {
    return nested;
  }
  return CALIBRATION_STATUS_KEYS.some((key) => key in direct) ? direct : {};
}

// A calibration_* reply that carries the whole calibration status (begin,
// abort, commit, enable, the one-tap zero...). Capture and dump replies carry
// other shapes and are not a status.
export function isFullCalibrationStatus(value: unknown) {
  const source = calibrationSource(value);
  return ['enabled', 'session_active', 'tare_complete', 'levels'].every((key) => key in source);
}

function parseCaptureSummary(value: unknown, fallbackSource: string): CalibrationCaptureSummary | null {
  const source = recordValue(value);
  if (Object.keys(source).length === 0) return null;
  return {
    captured_points: numberValue(source.captured_points, 0),
    total_points: numberValue(source.total_points, 0),
    missing_points: numberValue(source.missing_points, 0),
    complete: source.complete === true,
    source: typeof source.source === 'string' ? source.source : fallbackSource,
  };
}

function parseSummaryList(value: unknown, fallbackSource: string): CalibrationSummary[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => recordValue(item))
    .filter((item) => Object.keys(item).length > 0)
    .map((item) => ({
      level: numberValue(item.level, 0),
      reference: numberValue(item.reference, numberValue(item.level, 0)),
      captured_points: numberValue(item.captured_points, 0),
      total_points: numberValue(item.total_points, 0),
      missing_points: numberValue(item.missing_points, 0),
      complete: item.complete === true,
      source: typeof item.source === 'string' ? item.source : fallbackSource,
    }))
    .sort((a, b) => a.level - b.level);
}

function parseFitSummary(value: unknown): CalibrationFitSummary | null {
  const source = recordValue(value);
  if (Object.keys(source).length === 0) return null;
  const failures = recordValue(source.failures);
  return {
    cells_total: numberValue(source.cells_total, 0),
    cells_fitted: numberValue(source.cells_fitted, 0),
    complete: source.complete === true,
    failures: {
      no_tare: numberValue(failures.no_tare, 0),
      too_few_points: numberValue(failures.too_few_points, 0),
      singular: numberValue(failures.singular, 0),
    },
    failed: (Array.isArray(source.failed) ? source.failed : [])
      .map((item) => recordValue(item))
      .map((item) => ({ sensor_index: numberValue(item.sensor_index, -1), reason: String(item.reason ?? '') }))
      .filter((item) => item.sensor_index >= 0),
    partial_save: source.partial_save === true,
    point_levels: (Array.isArray(source.point_levels) ? source.point_levels : [])
      .map((item) => numberValue(item, Number.NaN))
      .filter((item) => Number.isFinite(item)),
    points: typeof source.points === 'string' ? source.points : '',
  };
}

function parseFitSettings(value: unknown): CalibrationFitSettings | null {
  const source = recordValue(value);
  if (Object.keys(source).length === 0) return null;
  return {
    min_level: numberValue(source.min_level, 0),
    min_points: numberValue(source.min_points, 3),
    readout: (Array.isArray(source.readout) ? source.readout : []).map((item) => {
      const entry = recordValue(item);
      return {
        adc: numberValue(entry.adc, 0),
        c1: numberValue(entry.c1, 1),
        c2: numberValue(entry.c2, 0),
        clip_mv: numberValue(entry.clip_mv, 0),
      };
    }),
  };
}

export function parseCalibrationState(value: unknown): CalibrationState {
  const source = calibrationSource(value);
  const enabled = source.enabled === true;
  const complete = source.complete === true;
  const reportedMode = source.output_mode;
  const outputModeReported = reportedMode === 'raw' || reportedMode === 'tared' || reportedMode === 'calibrated';
  return {
    enabled,
    mode_active: source.mode_active === true,
    session_active: source.session_active === true,
    complete,
    tare_complete: source.tare_complete === true,
    tare_enabled: typeof source.tare_enabled === 'boolean' ? source.tare_enabled : null,
    output_mode: outputModeReported ? reportedMode as CalibrationOutputMode : enabled && complete ? 'calibrated' : 'raw',
    output_mode_reported: outputModeReported,
    tare: parseCaptureSummary(source.tare, 'saved'),
    draft_tare: parseCaptureSummary(source.draft_tare, 'draft'),
    levels: parseSummaryList(source.levels, 'saved'),
    draft_levels: parseSummaryList(source.draft_levels, 'draft'),
    fit: parseFitSummary(source.fit),
    draft_fit: parseFitSummary(source.draft_fit),
    fit_settings: parseFitSettings(source.fit_settings),
    metadata: recordValue(source.metadata),
  };
}

// A stable key for the snapshot's calibration block, so a newer snapshot can
// be told apart from the one an override was taken against.
export function calibrationSnapshotKey(value: unknown) {
  try {
    return JSON.stringify(calibrationSource(value));
  } catch {
    return '';
  }
}

// The state to show: a command reply until the snapshot changes after it.
export function chooseCalibrationState(snapshot: unknown, override: CalibrationOverride | null): CalibrationState {
  if (override && override.snapshotKey === calibrationSnapshotKey(snapshot)) {
    return override.state;
  }
  return parseCalibrationState(snapshot);
}

export function getCalibrationStep(snapshot: CalibrationFlowSnapshot): CalibrationStep {
  if (!snapshot.sessionActive) return 'not_started';
  if (!snapshot.draftTareComplete || !snapshot.baselineConfirmed) return 'baseline';
  return 'levels';
}

// Save needs a baseline and a fit for every sensor -- the firmware refuses
// auto_enable otherwise. Sensors need not share levels: one pressed alone
// under a weight is fitted from its own captures.
export function canSaveCalibration(state: CalibrationState) {
  const fit = state.draft_fit;
  if (!state.session_active || state.draft_tare?.complete !== true || !fit) return false;
  // Older firmware refuses a profile that leaves any sensor unfitted.
  return fit.complete || (fit.partial_save && fit.cells_fitted > 0);
}

export type ZeroBlockedReason = 'device_offline' | 'session_active';

export function zeroBlockedReason(deviceConnected: boolean, state: CalibrationState): ZeroBlockedReason | null {
  if (!deviceConnected) return 'device_offline';
  if (state.session_active) return 'session_active';
  return null;
}

// i18n key for a firmware/transport error code from a calibration command.
export type CalibrationErrorKey =
  | 'calErrorTareRequired' | 'calErrorSessionActive' | 'calErrorIncomplete' | 'calErrorMaintenanceRequired'
  | 'calErrorNoResponse' | 'calErrorReplyTimeout' | 'calErrorReplyTooLarge' | 'calErrorGeneric';

export function calibrationErrorKey(code: string): CalibrationErrorKey {
  switch (code) {
    case 'calibration_tare_required':
      return 'calErrorTareRequired';
    case 'calibration_session_active':
      return 'calErrorSessionActive';
    case 'calibration_incomplete':
      return 'calErrorIncomplete';
    case 'maintenance_required':
      return 'calErrorMaintenanceRequired';
    case '':
    case 'no_response':
      return 'calErrorNoResponse';
    // Relay failures (a Hub, or a Gateway) rather than device errors.
    case 'command_delivery_timeout':
    case 'result_page_timeout':
    // Studio only: the host gave up waiting for the reply (COMMAND_RESULT_TIMEOUT_MS).
    case 'command_timeout':
      return 'calErrorReplyTimeout';
    case 'response_too_large':
    case 'result_page_expired':
    case 'command_too_large':
      return 'calErrorReplyTooLarge';
    default:
      return 'calErrorGeneric';
  }
}
