// Ported from New-Horizons-Desktop/frontend/src/lib/scanHealth.ts (tests in
// test/renderer/ported.test.ts keep tests/scanHealth.test.mjs's behaviour).
// The firmware's `scan_health` (also embedded in `status`), reshaped for the
// Diagnostics page. Fields a firmware does not report come back null, so the
// card can say "not reported" instead of showing a stale or made-up 0.

type Raw = Record<string, unknown>;

function record(value: unknown): Raw {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : {};
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const numbers = value.map(num);
  return numbers.every((item) => item !== null) ? (numbers as number[]) : null;
}

// ESP32-S3: GPIO1-10 are ADC1, GPIO11-20 ADC2 (the firmware splits its
// calibration readout settings the same way).
export const FIRST_ADC2_GPIO = 11;

export function adcUnitForGpio(gpio: number): 1 | 2 {
  return gpio >= FIRST_ADC2_GPIO ? 2 : 1;
}

export type AdcUnitHealth = {
  unit: 1 | 2;
  // eFuse calibration point (the code the chip read for 850 mV at 12 dB);
  // 0 = none, and the firmware falls back to the core's own conversion.
  calDigi: number;
  // Reads that failed (ADC2 losing arbitration to Wi-Fi) and held the
  // cell's previous value; cumulative since boot.
  readErrors: number;
  // Analog row GPIOs of the active layout on this unit.
  gpios: number[];
};

export type LatenessBucket = {
  // Lower / upper bound in µs; upper null for the open last bucket.
  fromUs: number;
  toUs: number | null;
  count: number;
  share: number;
};

export type ScanHealthView = {
  active: boolean | null;
  targetFps: number | null;
  actualFps: number | null;
  budgetUs: number | null;
  lastScanUs: number | null;
  maxScanUs: number | null;
  overrunFrames: number | null;
  producedFrames: number | null;
  lateness: {
    samples: number;
    late: number;
    lateShare: number;
    maxUs: number | null;
    recentMaxUs: number | null;
    gaps: number | null;
    buckets: LatenessBucket[];
  } | null;
  udpSent: number | null;
  udpFailures: number | null;
  lastUdpSendUs: number | null;
  queueCapacity: number | null;
  queueOccupied: number | null;
  queueDropped: number | null;
  queueMaxOccupied: number | null;
  // null: the firmware predates ADC reporting.
  adc: AdcUnitHealth[] | null;
};

export function scanHealthView(source: unknown, analogPins: number[] = []): ScanHealthView {
  const raw = record(source);
  const late = record(raw.start_lateness);
  const samples = num(late.samples);
  let lateness: ScanHealthView["lateness"] = null;
  if (samples !== null) {
    const hist = numArray(late.hist) ?? [];
    const bounds = numArray(late.bounds_us) ?? [];
    const lateCount = num(late.late) ?? 0;
    const histTotal = hist.reduce((sum, count) => sum + count, 0);
    lateness = {
      samples,
      late: lateCount,
      lateShare: samples > 0 ? lateCount / samples : 0,
      maxUs: num(late.max_us),
      recentMaxUs: num(late.recent_max_us),
      gaps: num(late.gaps),
      buckets: hist.map((count, index) => ({
        fromUs: index === 0 ? 0 : bounds[index - 1] ?? 0,
        toUs: index < bounds.length ? (bounds[index] ?? null) : null,
        count,
        share: histTotal > 0 ? count / histTotal : 0,
      })),
    };
  }

  const errors = numArray(raw.adc_read_errors);
  const digi = numArray(raw.adc_cal_digi);
  const adc =
    errors && digi && errors.length >= 2 && digi.length >= 2
      ? ([1, 2] as const).map((unit) => ({
          unit,
          calDigi: digi[unit - 1] ?? 0,
          readErrors: errors[unit - 1] ?? 0,
          gpios: analogPins.filter((gpio) => adcUnitForGpio(gpio) === unit),
        }))
      : null;

  return {
    active: typeof raw.scan_active === "boolean" ? raw.scan_active : null,
    targetFps: num(raw.requested_target_fps),
    actualFps: num(raw.actual_scan_fps),
    budgetUs: num(raw.budget_us),
    lastScanUs: num(raw.last_scan_duration_us),
    maxScanUs: num(raw.max_scan_duration_us),
    overrunFrames: num(raw.overrun_frames),
    producedFrames: num(raw.produced_frames),
    lateness,
    udpSent: num(raw.udp_sent_frames),
    udpFailures: num(raw.udp_send_failures),
    lastUdpSendUs: num(raw.last_udp_send_us),
    queueCapacity: num(raw.queue_capacity_frames),
    queueOccupied: num(raw.queue_occupied_frames),
    queueDropped: num(raw.queue_dropped_frames),
    queueMaxOccupied: num(raw.queue_max_occupied_frames),
    adc,
  };
}

// "850 µs", "12.3 ms": scan and send timings span both.
export function formatMicros(value: number | null): string {
  if (value === null) return "-";
  if (Math.abs(value) < 1000) return `${Math.round(value)} µs`;
  return `${(value / 1000).toFixed(1)} ms`;
}

export function formatBucketRange(bucket: LatenessBucket): string {
  if (bucket.toUs === null) return `≥ ${formatMicros(bucket.fromUs)}`;
  if (bucket.fromUs === 0) return `< ${formatMicros(bucket.toUs)}`;
  return `${formatMicros(bucket.fromUs)} – ${formatMicros(bucket.toUs)}`;
}

export type RssiQuality = "excellent" | "good" | "fair" | "weak";

export function rssiQuality(rssi: unknown): RssiQuality | null {
  const value = num(rssi);
  // 0 is what a disconnected radio reports, not a perfect signal.
  if (value === null || value >= 0) return null;
  if (value >= -55) return "excellent";
  if (value >= -67) return "good";
  if (value >= -75) return "fair";
  return "weak";
}

// A scan rate this far under its target is worth flagging.
export function scanRateLow(view: ScanHealthView): boolean {
  return (
    view.active === true &&
    view.actualFps !== null &&
    view.targetFps !== null &&
    view.targetFps > 0 &&
    view.actualFps < view.targetFps * 0.95
  );
}

// Reset reasons that mean something went wrong, as opposed to a power-on,
// a reboot command, deep sleep or a USB/JTAG reset.
const FAULT_RESETS = new Set(["panic", "int_wdt", "task_wdt", "other_wdt", "brownout", "cpu_lockup", "pwr_glitch"]);

export function isFaultReset(reason: string): boolean {
  return FAULT_RESETS.has(reason);
}
