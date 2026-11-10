// Ported from New-Horizons-Desktop/frontend/src/lib/batteryProfile.ts; keep in step.
export type BatteryProfileStatus = {
  soc_centi_percent?: unknown;
  soc_percent?: unknown;
  vbat_mv?: unknown;
  rate?: unknown;
  sample_valid?: unknown;
  battery_present?: unknown;
  present?: unknown;
  profile_required?: unknown;
  battery_profile_required?: unknown;
  profile_resolved?: unknown;
  profile_source?: unknown;
  /** v2.0.F: the ID resistor read once at boot. */
  battery_id?: unknown;
  capacity_mah?: unknown;
  max_charge_current_ma?: unknown;
  temperature_monitoring?: unknown;
  thermal_monitoring_bypass?: unknown;
  gauge_sync_state?: unknown;
  last_sync_reason?: unknown;
  gauge_sync_count?: unknown;
};

/** What the BAT_ID pin showed at boot (v2.0.F). `kind` is none / known / reserved / invalid. */
export type BatteryIdViewModel = {
  readOk: boolean | null;
  kind: string | null;
  mv: number | null;
  ohm: number | null;
};

export type BatteryStatusViewModel = {
  socPercent: number | null;
  vbatMv: number | null;
  ratePercentPerHour: number | null;
  batteryPresent: boolean | null;
  profileSource: string | null;
  batteryId: BatteryIdViewModel | null;
  profileResolved: boolean | null;
  profileRequired: boolean | null;
  capacityMah: number | null;
  maxChargeCurrentMa: number | null;
  thermalMonitoringBypassed: boolean | null;
  syncState: "ready" | "syncing" | "error" | null;
  lastSyncReason: string | null;
  syncCount: number | null;
};

export type BatteryTimeEstimate =
  | { kind: "remaining"; minutes: number }
  | { kind: "until_full"; minutes: number }
  | { kind: "full" }
  | { kind: "unavailable" };

function clampPercent(value: number | null): number | null {
  return value === null ? null : Math.max(0, Math.min(100, value));
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function optionalGaugeSyncState(value: unknown): BatteryStatusViewModel["syncState"] {
  return value === "ready" || value === "syncing" || value === "error" ? value : null;
}

export function batteryFillPercent(socPercent: number | null): number | null {
  if (socPercent === null || !Number.isFinite(socPercent)) return null;
  return Math.max(0, Math.min(100, socPercent));
}

export function batteryIndicatorState(
  supported: boolean,
  socPercent: number | null,
  charging: boolean,
) {
  if (!supported) return null;
  const fillPercent = batteryFillPercent(socPercent);
  return {
    fillPercent,
    label: fillPercent === null ? null : `${Math.round(fillPercent)}%`,
    charging,
  };
}

function normalizeBatteryId(value: unknown): BatteryIdViewModel | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  return {
    readOk: optionalBoolean(record.read_ok),
    kind: optionalString(record.kind),
    mv: finiteNumber(record.mv),
    ohm: finiteNumber(record.ohm),
  };
}

/** Battery recognised from its ID resistor, so the capacity is not the operator's setting. */
export function batteryRecognisedFromId(battery: BatteryStatusViewModel): boolean {
  return battery.profileSource === 'auto';
}

export function normalizeBatteryStatus(status: BatteryProfileStatus): BatteryStatusViewModel {
  const socCentiPercent = finiteNumber(status.soc_centi_percent);
  const thermalMonitoring = optionalString(status.temperature_monitoring);
  const rate = finiteNumber(status.rate);
  const syncState = optionalGaugeSyncState(status.gauge_sync_state);
  const measurementsValid = optionalBoolean(status.sample_valid) !== false && syncState !== "syncing" && syncState !== "error";
  return {
    // Firmware before the full-charge scaling sent the gauge's raw value,
    // which can read over 100%.
    socPercent: measurementsValid ? clampPercent(socCentiPercent === null ? finiteNumber(status.soc_percent) : socCentiPercent / 100) : null,
    vbatMv: measurementsValid ? finiteNumber(status.vbat_mv) : null,
    ratePercentPerHour: measurementsValid && rate !== null ? rate / 100 : null,
    batteryPresent: optionalBoolean(status.battery_present) ?? optionalBoolean(status.present),
    profileSource: optionalString(status.profile_source),
    batteryId: normalizeBatteryId(status.battery_id),
    profileResolved: optionalBoolean(status.profile_resolved),
    profileRequired: optionalBoolean(status.profile_required) ?? optionalBoolean(status.battery_profile_required),
    capacityMah: finiteNumber(status.capacity_mah),
    maxChargeCurrentMa: finiteNumber(status.max_charge_current_ma),
    thermalMonitoringBypassed: thermalMonitoring === "bypassed" ? true : optionalBoolean(status.thermal_monitoring_bypass),
    syncState,
    lastSyncReason: optionalString(status.last_sync_reason),
    syncCount: finiteNumber(status.gauge_sync_count),
  };
}

export function batteryProfileSetupRequired(status: BatteryProfileStatus): boolean {
  const battery = normalizeBatteryStatus(status);
  return battery.profileRequired === true || battery.profileResolved === false;
}

// The lab's batteries. Choosing one also sets how fast it may be charged;
// only "custom" takes a typed current.
export const BATTERY_PRESETS = [
  { capacityMah: 200, maxChargeCurrentMa: 100 },
  { capacityMah: 400, maxChargeCurrentMa: 200 },
  { capacityMah: 500, maxChargeCurrentMa: 350 },
  { capacityMah: 600, maxChargeCurrentMa: 350 },
  { capacityMah: 700, maxChargeCurrentMa: 350 },
] as const;

export type BatteryCapacityChoice = `${(typeof BATTERY_PRESETS)[number]["capacityMah"]}` | "custom";

export function batteryPresetFor(choice: BatteryCapacityChoice) {
  return BATTERY_PRESETS.find((preset) => String(preset.capacityMah) === choice) ?? null;
}

/** The form's choice for a capacity the device reports: its preset, else custom. */
export function batteryCapacityChoiceFor(capacityMah: number, maxChargeCurrentMa: number): BatteryCapacityChoice {
  const preset = BATTERY_PRESETS.find((item) => item.capacityMah === capacityMah && item.maxChargeCurrentMa === maxChargeCurrentMa);
  return preset ? (String(preset.capacityMah) as BatteryCapacityChoice) : "custom";
}

function batteryProfileValues(capacityChoice: BatteryCapacityChoice, customCapacity: string, maxChargeCurrent: string) {
  const preset = batteryPresetFor(capacityChoice);
  return preset
    ? { capacityMah: preset.capacityMah as number, maxChargeCurrentMa: preset.maxChargeCurrentMa as number }
    : { capacityMah: Number(customCapacity), maxChargeCurrentMa: Number(maxChargeCurrent) };
}

export function batteryProfileValidationError(
  capacityChoice: BatteryCapacityChoice,
  customCapacity: string,
  maxChargeCurrent: string,
): "invalid_battery_profile" | null {
  const { capacityMah, maxChargeCurrentMa } = batteryProfileValues(capacityChoice, customCapacity, maxChargeCurrent);
  return !Number.isInteger(capacityMah) || capacityMah <= 0 || !Number.isInteger(maxChargeCurrentMa) || maxChargeCurrentMa < 100 || maxChargeCurrentMa > 350 || maxChargeCurrentMa % 10 !== 0
    ? "invalid_battery_profile"
    : null;
}

export function buildBatteryProfileCommand(
  capacityChoice: BatteryCapacityChoice,
  customCapacity: string,
  maxChargeCurrent: string,
) {
  const validationError = batteryProfileValidationError(capacityChoice, customCapacity, maxChargeCurrent);
  if (validationError) {
    throw new Error(validationError);
  }
  const { capacityMah, maxChargeCurrentMa } = batteryProfileValues(capacityChoice, customCapacity, maxChargeCurrent);
  return { command: "set_battery_profile" as const, capacity_mah: capacityMah, max_charge_current_ma: maxChargeCurrentMa };
}

export function buildBatteryGaugeResyncCommand() {
  return { command: "resync_battery_gauge" as const };
}

export function estimateBatteryTime(
  battery: Pick<BatteryStatusViewModel, "socPercent" | "ratePercentPerHour" | "batteryPresent">,
  chargeState: string,
): BatteryTimeEstimate {
  if (battery.batteryPresent !== true || battery.socPercent === null) {
    return { kind: "unavailable" };
  }
  if (chargeState === "charge_done") {
    return { kind: "full" };
  }
  const rate = battery.ratePercentPerHour;
  if (rate === null || Math.abs(rate) < 0.1) {
    return { kind: "unavailable" };
  }
  if (chargeState === "charging" && rate > 0) {
    return {
      kind: "until_full",
      minutes: Math.max(0, Math.round(((100 - battery.socPercent) / rate) * 60)),
    };
  }
  if (chargeState !== "charging" && rate < 0) {
    return {
      kind: "remaining",
      minutes: Math.round((battery.socPercent / Math.abs(rate)) * 60),
    };
  }
  return { kind: "unavailable" };
}

export function batteryLedThresholdValidationError(value: unknown): "invalid_low_battery_threshold" | null {
  return typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 25
    ? "invalid_low_battery_threshold"
    : null;
}

export function buildBatteryLedThresholdCommand(lowBatteryThresholdPercent: number) {
  if (batteryLedThresholdValidationError(lowBatteryThresholdPercent)) {
    throw new Error("invalid_low_battery_threshold");
  }
  return {
    command: "set_indicators" as const,
    battery_led: { low_battery_threshold_percent: lowBatteryThresholdPercent },
  };
}

export function durationLabel(minutes: number) {
  const safeMinutes = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safeMinutes / 60);
  const remainingMinutes = safeMinutes % 60;
  if (hours > 0 && remainingMinutes > 0) return `${hours}h ${remainingMinutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${remainingMinutes}m`;
}

// Mirrors the firmware's own low-battery rule in BatteryLedPolicy.cpp: the
// dedicated v1.5.F battery pixel only fast-blinks when the pack is NOT
// charging and sits at or below a configured, non-zero threshold (a threshold
// of 0 disables the warning outright). Keeping the two in lockstep means the
// WebUI never warns while the board itself is calm, or vice versa.
export function isLowBattery(
  socPercent: number | null,
  charging: boolean,
  thresholdPercent: number | null,
): boolean {
  if (thresholdPercent === null || thresholdPercent <= 0) return false;
  if (socPercent === null || charging) return false;
  return socPercent <= thresholdPercent;
}

export type DeviceBatteryReadout = {
  supported: boolean;
  socPercent: number | null;
  charging: boolean;
  syncing: boolean;
  lowBattery: boolean;
  estimate: BatteryTimeEstimate;
};

export function deviceBatteryReadout(input: {
  supported: boolean;
  battery: BatteryProfileStatus;
  power: Record<string, unknown>;
  batteryLed: Record<string, unknown>;
}): DeviceBatteryReadout {
  const battery = normalizeBatteryStatus(input.battery);
  const chargeState = optionalString(input.power.charge_state ?? (input.battery as Record<string, unknown>).charge_state) ?? "";
  const syncing = battery.syncState === "syncing";
  const charging = chargeState === "charging" && !syncing;
  // Only ever warn on a threshold the board actually reported -- inventing a
  // default here would fire a false alarm on a device whose owner set 0.
  const thresholdPercent = finiteNumber(input.batteryLed.low_battery_threshold_percent);
  return {
    supported: input.supported,
    socPercent: input.supported ? battery.socPercent : null,
    charging,
    syncing,
    lowBattery: input.supported && isLowBattery(battery.socPercent, charging, thresholdPercent),
    estimate: input.supported ? estimateBatteryTime(battery, chargeState) : { kind: "unavailable" },
  };
}
