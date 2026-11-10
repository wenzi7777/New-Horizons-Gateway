// board_profile.py: what each known board is, so a v5 packet carrying
// extensions can be split without a status reply (datagram_ingest.py).
import { pyStrip } from '../../../core/src/py';
import { pyStrOr } from './pyJson';

export type BoardProfile = {
  hardware_model: string;
  supports_external_led: boolean;
  supports_oled: boolean;
  supports_local_button_wake: boolean;
  supports_charge_control: boolean;
  power_ux: string;
  default_manifest_url?: string;
  default_analog_pins?: number[];
  default_select_pins?: number[];
  external_led_count?: number;
  external_led_pin?: number;
};

// Older firmware reports these as "VD-CTL/R ..." (before v1.8.0) or
// "TIA-CTL/R ..." (v1.8.0); normalizeHardwareModel() folds both in.
export const V1_HARDWARE_MODEL = 'TIA-CTL v1.0.F 2026.4';
export const V15F_HARDWARE_MODEL = 'TIA-CTL v1.5.F 2026.7';
export const V20F_HARDWARE_MODEL = 'TIA-CTL v2.0.F 2026.10';
export const V21_GCU_HARDWARE_MODEL = 'TIA-CTL v2.1 GCU LTS';
export const V22C_GCU_HARDWARE_MODEL = 'TIA-CTL v2.2.C GCU LTS';
export const GCU_HARDWARE_MODEL = 'TIA-CTL v2.3.D GCU LTS';

export const DEFAULT_BOARD_PROFILE: BoardProfile = {
  hardware_model: V1_HARDWARE_MODEL,
  supports_external_led: true,
  supports_oled: true,
  supports_local_button_wake: true,
  supports_charge_control: true,
  power_ux: 'local_button',
  external_led_count: 3,
  external_led_pin: 12,
};

export const V15F_BOARD_PROFILE: BoardProfile = {
  hardware_model: V15F_HARDWARE_MODEL,
  supports_external_led: true,
  supports_oled: true,
  supports_local_button_wake: true,
  supports_charge_control: true,
  power_ux: 'local_button',
  default_manifest_url: 'https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-v15f-latest.json',
  default_analog_pins: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  default_select_pins: [17, 18, 21, 26, 47, 33, 34, 48, 35, 36, 37, 38, 39, 45],
  external_led_count: 9,
  external_led_pin: 16,
};

export const V20F_BOARD_PROFILE: BoardProfile = {
  hardware_model: V20F_HARDWARE_MODEL,
  supports_external_led: true,
  supports_oled: true,
  supports_local_button_wake: true,
  supports_charge_control: true,
  power_ux: 'local_button',
  default_manifest_url: 'https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-v20f-latest.json',
  default_analog_pins: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  default_select_pins: [17, 18, 21, 26, 47, 33, 34, 48, 35, 36, 37, 38, 39, 45],
  external_led_count: 9,
  external_led_pin: 16,
};

const remoteOnly = (hardware_model: string, supports_charge_control: boolean): BoardProfile => ({
  hardware_model,
  supports_external_led: false,
  supports_oled: false,
  supports_local_button_wake: false,
  supports_charge_control,
  power_ux: 'remote_only',
});

export const V21_GCU_BOARD_PROFILE = remoteOnly(V21_GCU_HARDWARE_MODEL, false);
export const V22C_GCU_BOARD_PROFILE = remoteOnly(V22C_GCU_HARDWARE_MODEL, false);
export const GCU_BOARD_PROFILE = remoteOnly(GCU_HARDWARE_MODEL, true);

export const KNOWN_BOARD_PROFILES: readonly BoardProfile[] = [
  V21_GCU_BOARD_PROFILE,
  V22C_GCU_BOARD_PROFILE,
  GCU_BOARD_PROFILE,
  V20F_BOARD_PROFILE,
  V15F_BOARD_PROFILE,
  DEFAULT_BOARD_PROFILE,
];


export function normalizeHardwareModel(value: unknown): string {
  // str(value or "").strip().lower()
  const normalized = pyStrip(pyStrOr(value)).toLowerCase();
  for (const legacy of ['vd-ctl/r', 'tia-ctl/r']) {
    if (normalized.startsWith(legacy)) return `tia-ctl${normalized.slice(legacy.length)}`;
  }
  return normalized;
}

export function boardProfileForHardwareModel(value: unknown): BoardProfile {
  const normalized = normalizeHardwareModel(value);
  for (const profile of KNOWN_BOARD_PROFILES) {
    if (normalizeHardwareModel(profile.hardware_model) === normalized) return clone(profile);
  }
  return clone(DEFAULT_BOARD_PROFILE);
}

function clone(profile: BoardProfile): BoardProfile {
  return {
    ...profile,
    ...(profile.default_analog_pins ? { default_analog_pins: [...profile.default_analog_pins] } : {}),
    ...(profile.default_select_pins ? { default_select_pins: [...profile.default_select_pins] } : {}),
  };
}
