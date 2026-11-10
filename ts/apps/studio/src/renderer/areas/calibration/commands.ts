// Every calibration payload the workbench sends, exactly as the Desktop's
// CalibrationWorkbench builds them (NewHorizonsOS-OTA/spec/commands.md,
// calibration_*). Sensors are addressed by the firmware's column-major
// calibration index; only labels use the P1.. numbering (./sensorLabel.ts).

export type Payload = Record<string, unknown>;

export const ZERO_DURATION_MS = 1000;
export const BASELINE_DURATION_MS = 3000;
/** Captures block the device for their duration before it answers (Desktop margin). */
export const CAPTURE_TIMEOUT_MARGIN_MS = 40000;
export const MIN_CAPTURE_MS = 500;
/**
 * Studio's host waits COMMAND_RESULT_TIMEOUT_MS (20 s) for any reply and
 * cannot be told otherwise, so a capture must finish well inside that.
 */
export const MAX_CAPTURE_MS = 15000;
export const DEFAULT_CAPTURE_SECONDS = 3;

export function captureDurationMs(seconds: number): number {
  const ms = Math.round((Number.isFinite(seconds) ? seconds : DEFAULT_CAPTURE_SECONDS) * 1000);
  return Math.min(MAX_CAPTURE_MS, Math.max(MIN_CAPTURE_MS, ms));
}

export const calibrationStatusCommand = (): Payload => ({ command: 'calibration_status' });
export const enterMaintenanceCommand = (): Payload => ({ command: 'enter_maintenance', reason: 'calibration' });
export const exitMaintenanceCommand = (): Payload => ({ command: 'exit_maintenance' });

/** One-tap zero in normal mode (firmware v1.5.1+; older needs maintenance). */
export const zeroCommand = (): Payload => ({ command: 'calibration_tare_capture', duration_ms: ZERO_DURATION_MS });
export const zeroClearCommand = (): Payload => ({ command: 'calibration_tare_clear' });

export const sessionBeginCommand = (): Payload => ({ command: 'calibration_session_begin' });
export const sessionAbortCommand = (): Payload => ({ command: 'calibration_session_abort' });
/** Save: auto_enable switches the profile on (the firmware refuses it without a usable fit). */
export const sessionCommitCommand = (autoEnable = true): Payload => ({ command: 'calibration_session_commit', auto_enable: autoEnable });

export const captureBaselineCommand = (): Payload => ({ command: 'calibration_capture_tare', duration_ms: BASELINE_DURATION_MS });
export const captureAllCommand = (level: number, durationMs: number): Payload => ({ command: 'calibration_capture_all', level, duration_ms: durationMs });
export const captureCellCommand = (sensorIndex: number, level: number, durationMs: number): Payload => ({
  command: 'calibration_capture_cell',
  sensor_index: sensorIndex,
  level,
  duration_ms: durationMs,
});
/** The pressure actually applied at a captured level (what the fit uses), rounded as the Desktop's chamber flow does. */
export const setReferenceCommand = (level: number, reference: number): Payload => ({
  command: 'calibration_set_reference',
  level,
  reference: Number(reference.toFixed(3)),
});
export const deleteLevelCommand = (level: number): Payload => ({ command: 'calibration_delete_level', level });

export const enableCommand = (): Payload => ({ command: 'calibration_enable' });
export const disableCommand = (): Payload => ({ command: 'calibration_disable' });
export const clearProfileCommand = (): Payload => ({ command: 'calibration_clear_profile' });
/** Only min_level: the readout curve (c1/c2/clip) is deliberately not editable (Desktop parity). */
export const setFitCommand = (minLevel: number): Payload => ({ command: 'calibration_set_fit', min_level: minLevel });

export const dumpTareCommand = (): Payload => ({ command: 'calibration_dump_tare' });
export const dumpLevelCommand = (level: number): Payload => ({ command: 'calibration_dump_level', level });
export const dumpFitCommand = (): Payload => ({ command: 'calibration_dump_fit' });

export function captureTimeoutMs(durationMs: number): number {
  return durationMs + CAPTURE_TIMEOUT_MARGIN_MS;
}
