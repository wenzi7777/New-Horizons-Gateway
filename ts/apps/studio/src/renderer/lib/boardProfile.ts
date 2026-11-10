// Ported from New-Horizons-Desktop frontend/src/lib/boardProfile.ts (board
// photographs and manifest URL helpers left out: Studio does not ship them).

export type BoardPinSlot = {
  label: string;
  gpio?: number;
  role?: "analog" | "select";
};

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
const V21_GCU_HARDWARE_MODEL = "TIA-CTL v2.1 GCU LTS";
const V22C_GCU_HARDWARE_MODEL = "TIA-CTL v2.2.C GCU LTS";
const GCU_HARDWARE_MODEL = "TIA-CTL v2.3.D GCU LTS";

const V1_ANALOG_PIN_SLOTS: BoardPinSlot[] = [
  { label: "A0", gpio: 1, role: "analog" },
  { label: "A1", gpio: 2, role: "analog" },
  { label: "A2", gpio: 3, role: "analog" },
  { label: "A3", gpio: 4, role: "analog" },
  { label: "A4", gpio: 5, role: "analog" },
  { label: "A5", gpio: 6, role: "analog" },
  { label: "A6", gpio: 7, role: "analog" },
  { label: "A7", gpio: 8, role: "analog" },
  { label: "A8", gpio: 9, role: "analog" },
  { label: "A9", gpio: 10, role: "analog" },
  { label: "D19", gpio: 40, role: "select" },
  { label: "D20", gpio: 41, role: "select" },
  { label: "NC" },
  { label: "NC" },
  { label: "LED" },
  { label: "SDA" },
  { label: "SCL" },
  { label: "GND" },
  { label: "3V3" },
  { label: "5V" },
];

const V1_DIGITAL_PIN_SLOTS: BoardPinSlot[] = [
  { label: "D0", gpio: 13, role: "select" },
  { label: "D1", gpio: 14, role: "select" },
  { label: "D2", gpio: 15, role: "select" },
  { label: "D3", gpio: 16, role: "select" },
  { label: "D4", gpio: 17, role: "select" },
  { label: "D5", gpio: 18, role: "select" },
  { label: "D6", gpio: 19, role: "select" },
  { label: "D7", gpio: 20, role: "select" },
  { label: "D8", gpio: 21, role: "select" },
  { label: "D9", gpio: 26, role: "select" },
  { label: "D10", gpio: 47, role: "select" },
  { label: "D11", gpio: 33, role: "select" },
  { label: "D12", gpio: 34, role: "select" },
  { label: "D13", gpio: 48, role: "select" },
  { label: "NC" },
  { label: "D14", gpio: 35, role: "select" },
  { label: "D15", gpio: 36, role: "select" },
  { label: "D16", gpio: 37, role: "select" },
  { label: "D17", gpio: 38, role: "select" },
  { label: "D18", gpio: 39, role: "select" },
];

const V15F_ANALOG_PIN_SLOTS: BoardPinSlot[] = [
  { label: "A0", gpio: 1, role: "analog" },
  { label: "A1", gpio: 2, role: "analog" },
  { label: "A2", gpio: 3, role: "analog" },
  { label: "A3", gpio: 4, role: "analog" },
  { label: "A4", gpio: 5, role: "analog" },
  { label: "A5", gpio: 6, role: "analog" },
  { label: "A6", gpio: 7, role: "analog" },
  { label: "A7", gpio: 8, role: "analog" },
  { label: "A8", gpio: 9, role: "analog" },
  { label: "A9", gpio: 10, role: "analog" },
  { label: "A10", gpio: 11, role: "analog" },
  { label: "A11", gpio: 12, role: "analog" },
  { label: "A12", gpio: 13, role: "analog" },
  { label: "A13", gpio: 14, role: "analog" },
  { label: "LED", gpio: 16 },
  { label: "RX" },
  { label: "TX" },
  { label: "GND" },
  { label: "3V3" },
  { label: "5V" },
];

const V15F_DIGITAL_PIN_SLOTS: BoardPinSlot[] = [
  { label: "5V" },
  { label: "3V3" },
  { label: "GND" },
  { label: "GND" },
  { label: "SCL", gpio: 42 },
  { label: "SDA", gpio: 40 },
  { label: "D13", gpio: 45, role: "select" },
  { label: "D12", gpio: 39, role: "select" },
  { label: "D11", gpio: 38, role: "select" },
  { label: "D10", gpio: 37, role: "select" },
  { label: "D9", gpio: 36, role: "select" },
  { label: "D8", gpio: 35, role: "select" },
  { label: "D7", gpio: 48, role: "select" },
  { label: "D6", gpio: 34, role: "select" },
  { label: "D5", gpio: 33, role: "select" },
  { label: "D4", gpio: 47, role: "select" },
  { label: "D3", gpio: 26, role: "select" },
  { label: "D2", gpio: 21, role: "select" },
  { label: "D1", gpio: 18, role: "select" },
  { label: "D0", gpio: 17, role: "select" },
];

const GCU_DIGITAL_PIN_SLOTS: BoardPinSlot[] = [
  { label: "5V" },
  { label: "3V3" },
  { label: "3V3" },
  { label: "D46", gpio: 46, role: "select" },
  { label: "D45", gpio: 45, role: "select" },
  { label: "D42", gpio: 42, role: "select" },
  { label: "D41", gpio: 41, role: "select" },
  { label: "D40", gpio: 40, role: "select" },
  { label: "D39", gpio: 39, role: "select" },
  { label: "D37", gpio: 37, role: "select" },
  { label: "D36", gpio: 36, role: "select" },
  { label: "D35", gpio: 35, role: "select" },
  { label: "D21", gpio: 21, role: "select" },
  { label: "D20", gpio: 20, role: "select" },
  { label: "D19", gpio: 19, role: "select" },
  { label: "D18", gpio: 18, role: "select" },
  { label: "D17", gpio: 17, role: "select" },
  { label: "D16", gpio: 16, role: "select" },
  { label: "GND" },
  { label: "GND" },
];

const V21_GCU_DIGITAL_PIN_SLOTS: BoardPinSlot[] = [
  { label: "5V" },
  { label: "3V3" },
  { label: "3V3" },
  { label: "NC" },
  { label: "D45", gpio: 45, role: "select" },
  { label: "D42", gpio: 42, role: "select" },
  { label: "D41", gpio: 41, role: "select" },
  { label: "D40", gpio: 40, role: "select" },
  { label: "D39", gpio: 39, role: "select" },
  { label: "D37", gpio: 37, role: "select" },
  { label: "D36", gpio: 36, role: "select" },
  { label: "D35", gpio: 35, role: "select" },
  { label: "D21", gpio: 21, role: "select" },
  { label: "D20", gpio: 20, role: "select" },
  { label: "D19", gpio: 19, role: "select" },
  { label: "D18", gpio: 18, role: "select" },
  { label: "NC" },
  { label: "NC" },
  { label: "GND" },
  { label: "GND" },
];

const GCU_ANALOG_PIN_SLOTS: BoardPinSlot[] = [
  { label: "5V" },
  { label: "3V3" },
  { label: "3V3" },
  { label: "A1", gpio: 1, role: "analog" },
  { label: "A2", gpio: 2, role: "analog" },
  { label: "A3", gpio: 3, role: "analog" },
  { label: "A4", gpio: 4, role: "analog" },
  { label: "A5", gpio: 5, role: "analog" },
  { label: "A6", gpio: 6, role: "analog" },
  { label: "A7", gpio: 7, role: "analog" },
  { label: "A8", gpio: 8, role: "analog" },
  { label: "A9", gpio: 9, role: "analog" },
  { label: "A10", gpio: 10, role: "analog" },
  { label: "A11", gpio: 11, role: "analog" },
  { label: "A12", gpio: 12, role: "analog" },
  { label: "A13", gpio: 13, role: "analog" },
  { label: "A14", gpio: 14, role: "analog" },
  { label: "A15", gpio: 15, role: "analog" },
  { label: "GND" },
  { label: "GND" },
];

const V21_GCU_ANALOG_PIN_SLOTS: BoardPinSlot[] = [
  { label: "5V" },
  { label: "3V3" },
  { label: "3V3" },
  { label: "A1", gpio: 1, role: "analog" },
  { label: "A2", gpio: 2, role: "analog" },
  { label: "A3", gpio: 3, role: "analog" },
  { label: "A4", gpio: 4, role: "analog" },
  { label: "A5", gpio: 5, role: "analog" },
  { label: "A6", gpio: 6, role: "analog" },
  { label: "A7", gpio: 7, role: "analog" },
  { label: "A8", gpio: 8, role: "analog" },
  { label: "A9", gpio: 9, role: "analog" },
  { label: "A10", gpio: 10, role: "analog" },
  { label: "NC" },
  { label: "NC" },
  { label: "NC" },
  { label: "NC" },
  { label: "NC" },
  { label: "GND" },
  { label: "GND" },
];

const V22C_GCU_ANALOG_PIN_SLOTS: BoardPinSlot[] = [
  { label: "5V" },
  { label: "3V3" },
  { label: "3V3" },
  { label: "A1", gpio: 1, role: "analog" },
  { label: "A2", gpio: 2, role: "analog" },
  { label: "A3", gpio: 3, role: "analog" },
  { label: "A4", gpio: 4, role: "analog" },
  { label: "A5", gpio: 5, role: "analog" },
  { label: "A6", gpio: 6, role: "analog" },
  { label: "A7", gpio: 7, role: "analog" },
  { label: "A8", gpio: 8, role: "analog" },
  { label: "A9", gpio: 9, role: "analog" },
  { label: "A10", gpio: 10, role: "analog" },
  // IO11 reaches the connector but must not be used on this revision.
  { label: "DNU" },
  { label: "NC" },
  { label: "NC" },
  { label: "NC" },
  { label: "NC" },
  { label: "GND" },
  { label: "GND" },
];

const V22C_GCU_DIGITAL_PIN_SLOTS: BoardPinSlot[] = [
  { label: "5V" },
  { label: "3V3" },
  { label: "3V3" },
  { label: "NC" },
  { label: "D45", gpio: 45, role: "select" },
  { label: "D42", gpio: 42, role: "select" },
  { label: "D41", gpio: 41, role: "select" },
  { label: "D40", gpio: 40, role: "select" },
  { label: "D39", gpio: 39, role: "select" },
  { label: "D37", gpio: 37, role: "select" },
  { label: "D36", gpio: 36, role: "select" },
  { label: "D35", gpio: 35, role: "select" },
  { label: "D21", gpio: 21, role: "select" },
  { label: "D20", gpio: 20, role: "select" },
  { label: "D19", gpio: 19, role: "select" },
  { label: "D18", gpio: 18, role: "select" },
  // IO17 reaches the connector but must not be used on this revision.
  { label: "DNU" },
  { label: "NC" },
  { label: "GND" },
  { label: "GND" },
];

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
  overviewAsset: null,
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
  overviewAsset: null,
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
  overviewAsset: null,
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
  overviewAsset: null,
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
  overviewAsset: null,
  analogPinOrder: GCU_ANALOG_PIN_SLOTS.map((pin) => pin.label),
  digitalPinOrder: GCU_DIGITAL_PIN_SLOTS.map((pin) => pin.label),
  analogPinSlots: GCU_ANALOG_PIN_SLOTS,
  digitalPinSlots: GCU_DIGITAL_PIN_SLOTS,
  analogPinHeading: "ANALOG PINS",
  digitalPinHeading: "DIGITAL PINS",
};

const KNOWN_PROFILES = [V21_GCU_PROFILE, V22C_GCU_PROFILE, GCU_PROFILE, V15F_PROFILE, V1_PROFILE];

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
