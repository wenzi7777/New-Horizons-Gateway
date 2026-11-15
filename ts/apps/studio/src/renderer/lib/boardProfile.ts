// Ported from New-Horizons-Desktop frontend/src/lib/boardProfile.ts, with the
// same board overview artwork (assets/boards, used by the IO Visualizer).
import v10fOverview from "../assets/boards/VDCTLRv10F20264OVERVIEW.png";
import v15fOverview from "../assets/boards/VDCTLRv15F20267OVERVIEW.png";
import v20fOverview from "../assets/boards/TIACTLAv20F202610OVERVIEW.png";
import v21GcuOverview from "../assets/boards/VDCTLV21GCULTSOVERVIEW.png";
import v22cGcuOverview from "../assets/boards/VDCTLV22CGCULTSOVERVIEW.png";
import v23dGcuOverview from "../assets/boards/VDCTLV23DGCULTSOVERVIEW.png";

import { GCU_ANALOG_PIN_SLOTS, GCU_DIGITAL_PIN_SLOTS, V15F_ANALOG_PIN_SLOTS, V15F_DIGITAL_PIN_SLOTS, V1_ANALOG_PIN_SLOTS, V1_DIGITAL_PIN_SLOTS, V21_GCU_ANALOG_PIN_SLOTS, V21_GCU_DIGITAL_PIN_SLOTS, V22C_GCU_ANALOG_PIN_SLOTS, V22C_GCU_DIGITAL_PIN_SLOTS, type BoardPinSlot } from "@nhgw/host";

export type { BoardPinSlot };

export type BoardProfile = {
  hardwareModel: string;
  wikiSlug: string;
  /** OTA manifest without its suffix: the update channel adds -latest.json / -beta.json. */
  manifestBaseUrl: string;
  defaultAnalogPins: number[];
  defaultSelectPins: number[];
  /** The IO modal's pin picker; needs pin slots, not artwork. */
  supportsIoVisualizer: boolean;
  supportsExternalLed: boolean;
  supportsOled: boolean;
  /** A board photograph exists (overviewAsset). */
  supportsIoVisualizerArtwork: boolean;
  supportsLocalButtonWake: boolean;
  supportsChargeControl: boolean;
  supportsBatteryStatusLed: boolean;
  supportsBatteryPercentageIndicator: boolean;
  supportsActionButtonSettings: boolean;
  powerUx: "local_button" | "remote_only";
  overviewAsset: string | null;
  analogPinOrder: string[];
  digitalPinOrder: string[];
  analogPinSlots: BoardPinSlot[];
  digitalPinSlots: BoardPinSlot[];
  analogPinHeading: string;
  digitalPinHeading: string;
};

// Older firmware reports these same boards as "VD-CTL/R ..." (before v1.8.0)
// or "TIA-CTL/R ..." (v1.8.0); normalizeHardwareModel() folds both old
// prefixes in, so every spelling resolves to one profile.
export const V1_HARDWARE_MODEL = "TIA-CTL v1.0.F 2026.4";
export const V15F_HARDWARE_MODEL = "TIA-CTL v1.5.F 2026.7";
export const V20F_HARDWARE_MODEL = "TIA-CTL v2.0.F 2026.10";
const V21_GCU_HARDWARE_MODEL = "TIA-CTL v2.1 GCU LTS";
const V22C_GCU_HARDWARE_MODEL = "TIA-CTL v2.2.C GCU LTS";
const GCU_HARDWARE_MODEL = "TIA-CTL v2.3.D GCU LTS";

const V1_PROFILE: BoardProfile = {
  hardwareModel: V1_HARDWARE_MODEL,
  wikiSlug: "vd-ctl-r-v1.0f",
  manifestBaseUrl: "https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-v10f",
  defaultAnalogPins: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  defaultSelectPins: [13, 14, 15, 16, 17, 18, 19, 20, 21, 26, 47, 33, 34, 48, 40, 41, 35, 36, 37, 38, 39],
  supportsIoVisualizer: true,
  supportsExternalLed: true,
  supportsOled: true,
  supportsIoVisualizerArtwork: true,
  supportsLocalButtonWake: true,
  supportsChargeControl: true,
  supportsBatteryStatusLed: false,
  supportsBatteryPercentageIndicator: false,
  supportsActionButtonSettings: false,
  powerUx: "local_button",
  overviewAsset: v10fOverview,
  analogPinOrder: V1_ANALOG_PIN_SLOTS.map((pin) => pin.label),
  digitalPinOrder: V1_DIGITAL_PIN_SLOTS.map((pin) => pin.label),
  analogPinSlots: V1_ANALOG_PIN_SLOTS,
  digitalPinSlots: V1_DIGITAL_PIN_SLOTS,
  analogPinHeading: "ANA FPC",
  digitalPinHeading: "DIG FPC",
};

const V21_GCU_PROFILE: BoardProfile = {
  hardwareModel: V21_GCU_HARDWARE_MODEL,
  wikiSlug: "vd-ctl-r-v2-1-gcu-lts",
  manifestBaseUrl: "https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-gcu-v21-lts",
  defaultAnalogPins: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  defaultSelectPins: [18, 19, 20, 21, 35, 36, 37, 39, 40, 41, 42, 45],
  supportsIoVisualizer: true,
  supportsExternalLed: false,
  supportsOled: false,
  supportsIoVisualizerArtwork: true,
  supportsLocalButtonWake: false,
  supportsChargeControl: false,
  supportsBatteryStatusLed: false,
  supportsBatteryPercentageIndicator: false,
  supportsActionButtonSettings: false,
  powerUx: "remote_only",
  overviewAsset: v21GcuOverview,
  analogPinOrder: V21_GCU_ANALOG_PIN_SLOTS.map((pin) => pin.label),
  digitalPinOrder: V21_GCU_DIGITAL_PIN_SLOTS.map((pin) => pin.label),
  analogPinSlots: V21_GCU_ANALOG_PIN_SLOTS,
  digitalPinSlots: V21_GCU_DIGITAL_PIN_SLOTS,
  analogPinHeading: "ANALOG PINS",
  digitalPinHeading: "DIGITAL PINS",
};

const V22C_GCU_PROFILE: BoardProfile = {
  hardwareModel: V22C_GCU_HARDWARE_MODEL,
  wikiSlug: "vd-ctl-r-v2-2-c-gcu-lts",
  manifestBaseUrl: "https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-gcu-v22c-lts",
  // 10 x 12: IO11 and IO17 must not be used (see the board overview).
  defaultAnalogPins: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  defaultSelectPins: [18, 19, 20, 21, 35, 36, 37, 39, 40, 41, 42, 45],
  supportsIoVisualizer: true,
  supportsExternalLed: false,
  supportsOled: false,
  supportsIoVisualizerArtwork: true,
  supportsLocalButtonWake: false,
  supportsChargeControl: false,
  supportsBatteryStatusLed: false,
  supportsBatteryPercentageIndicator: false,
  supportsActionButtonSettings: false,
  powerUx: "remote_only",
  overviewAsset: v22cGcuOverview,
  analogPinOrder: V22C_GCU_ANALOG_PIN_SLOTS.map((pin) => pin.label),
  digitalPinOrder: V22C_GCU_DIGITAL_PIN_SLOTS.map((pin) => pin.label),
  analogPinSlots: V22C_GCU_ANALOG_PIN_SLOTS,
  digitalPinSlots: V22C_GCU_DIGITAL_PIN_SLOTS,
  analogPinHeading: "ANALOG PINS",
  digitalPinHeading: "DIGITAL PINS",
};

const V15F_PROFILE: BoardProfile = {
  hardwareModel: V15F_HARDWARE_MODEL,
  wikiSlug: "vd-ctl-r-v1-5f",
  manifestBaseUrl: "https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-v15f",
  defaultAnalogPins: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  defaultSelectPins: [17, 18, 21, 26, 47, 33, 34, 48, 35, 36, 37, 38, 39, 45],
  supportsIoVisualizer: true,
  supportsExternalLed: true,
  supportsOled: true,
  supportsIoVisualizerArtwork: true,
  supportsLocalButtonWake: true,
  supportsChargeControl: true,
  supportsBatteryStatusLed: true,
  supportsBatteryPercentageIndicator: true,
  supportsActionButtonSettings: true,
  powerUx: "local_button",
  overviewAsset: v15fOverview,
  analogPinOrder: V15F_ANALOG_PIN_SLOTS.map((pin) => pin.label),
  digitalPinOrder: V15F_DIGITAL_PIN_SLOTS.map((pin) => pin.label),
  analogPinSlots: V15F_ANALOG_PIN_SLOTS,
  digitalPinSlots: V15F_DIGITAL_PIN_SLOTS,
  analogPinHeading: "Analog Pins",
  digitalPinHeading: "Digital Pins",
};

// v2.0.F: same connector pins and matrix as v1.5.F.
const V20F_PROFILE: BoardProfile = {
  hardwareModel: V20F_HARDWARE_MODEL,
  wikiSlug: "vd-ctl-r-v2-0-f",
  manifestBaseUrl: "https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-v20f",
  defaultAnalogPins: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  defaultSelectPins: [17, 18, 21, 26, 47, 33, 34, 48, 35, 36, 37, 38, 39, 45],
  supportsIoVisualizer: true,
  supportsExternalLed: true,
  supportsOled: true,
  supportsIoVisualizerArtwork: true,
  supportsLocalButtonWake: true,
  supportsChargeControl: true,
  supportsBatteryStatusLed: true,
  supportsBatteryPercentageIndicator: true,
  supportsActionButtonSettings: true,
  powerUx: "local_button",
  overviewAsset: v20fOverview,
  analogPinOrder: V15F_ANALOG_PIN_SLOTS.map((pin) => pin.label),
  digitalPinOrder: V15F_DIGITAL_PIN_SLOTS.map((pin) => pin.label),
  analogPinSlots: V15F_ANALOG_PIN_SLOTS,
  digitalPinSlots: V15F_DIGITAL_PIN_SLOTS,
  analogPinHeading: "Analog Pins",
  digitalPinHeading: "Digital Pins",
};

const GCU_PROFILE: BoardProfile = {
  hardwareModel: GCU_HARDWARE_MODEL,
  wikiSlug: "vd-ctl-r-v2-3-d-gcu-lts",
  manifestBaseUrl: "https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-gcu-v23d-lts",
  defaultAnalogPins: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  defaultSelectPins: [16, 17, 18, 19, 20, 21, 35, 36, 37, 39, 40, 41, 42, 45, 46],
  supportsIoVisualizer: true,
  supportsExternalLed: false,
  supportsOled: false,
  supportsIoVisualizerArtwork: true,
  supportsLocalButtonWake: false,
  supportsChargeControl: true,
  supportsBatteryStatusLed: false,
  supportsBatteryPercentageIndicator: false,
  supportsActionButtonSettings: false,
  powerUx: "remote_only",
  overviewAsset: v23dGcuOverview,
  analogPinOrder: GCU_ANALOG_PIN_SLOTS.map((pin) => pin.label),
  digitalPinOrder: GCU_DIGITAL_PIN_SLOTS.map((pin) => pin.label),
  analogPinSlots: GCU_ANALOG_PIN_SLOTS,
  digitalPinSlots: GCU_DIGITAL_PIN_SLOTS,
  analogPinHeading: "ANALOG PINS",
  digitalPinHeading: "DIGITAL PINS",
};

const KNOWN_PROFILES = [V21_GCU_PROFILE, V22C_GCU_PROFILE, GCU_PROFILE, V20F_PROFILE, V15F_PROFILE, V1_PROFILE];

export function normalizeHardwareModel(value: string) {
  return value.trim().toLowerCase().replace(/^(vd|tia)-ctl\/r\b/, "tia-ctl");
}

function slugifyHardwareModel(value: string) {
  return value
    .toLowerCase()
    .replace(/^tia-ctl(\/r)?\b/, "vd-ctl/r") // wiki directories kept the old name
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-2026-4$/, "")
    .replace(/-2026-7$/, "")
    .replace(/-2026-10$/, "")
    .replace(/-v1-0-f$/, "-v1.0f")
    .replace(/^-+|-+$/g, "");
}

export const DEFAULT_BOARD_PROFILE = V1_PROFILE;

export function boardProfileForHardwareModel(value: string | null | undefined): BoardProfile {
  const normalized = normalizeHardwareModel(String(value ?? ""));
  const matched = KNOWN_PROFILES.find((profile) => normalizeHardwareModel(profile.hardwareModel) === normalized);
  return matched ?? DEFAULT_BOARD_PROFILE;
}

/** Name shown in the UI for a board: older firmware still reports "VD-CTL/R ..." or "TIA-CTL/R ...". */
export function displayHardwareModel(value: string | null | undefined): string {
  return String(value ?? "").replace(/^(VD|TIA)-CTL\/R\b/, "TIA-CTL");
}

export function wikiSlugFromHardwareModel(value: string | null | undefined): string {
  const input = String(value ?? "").trim();
  if (!input) return DEFAULT_BOARD_PROFILE.wikiSlug;
  const normalized = normalizeHardwareModel(input);
  const matched = KNOWN_PROFILES.find((profile) => normalizeHardwareModel(profile.hardwareModel) === normalized);
  return matched?.wikiSlug ?? slugifyHardwareModel(input);
}
