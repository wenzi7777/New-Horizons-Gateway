// Sensor-layout profiles in the Desktop's on-disk format
// (New-Horizons-Desktop backend api.py /api/profiles, data/profiles/*.json):
//
//   { version, name, deviceType, matrix: {rows, cols}, activeRows, activeCols,
//     background: {imageData: "data:image/...;base64,...", aspectRatio},
//     sensors: [{index, x, y, label, enabled}], display: {mode, pressureMin,
//     pressureMax, dotSize}, notes }
//
// x / y are 0..1 ratios of the background image; index is the row-major
// stream index (label "P<index+1>"). Every function here keeps fields it
// does not know about (top level, nested objects and each sensor), so a
// profile written by a newer Desktop or server survives an edit here.

export type ProfileDisplayMode = '2d' | '3d';

export interface ProfileSensor {
  index: number;
  x: number;
  y: number;
  label: string;
  enabled: boolean;
  [extra: string]: unknown;
}

export interface Profile {
  version: number;
  name: string;
  deviceType: string;
  matrix: { rows: number; cols: number; [extra: string]: unknown };
  activeRows: number[];
  activeCols: number[];
  background: { imageData: string; aspectRatio: number; [extra: string]: unknown };
  sensors: ProfileSensor[];
  display: { mode: ProfileDisplayMode; pressureMin: number; pressureMax: number; dotSize: number; [extra: string]: unknown };
  notes: string;
  [extra: string]: unknown;
}

export const PROFILE_DEFAULTS = {
  rows: 10,
  cols: 21,
  pressureMin: 300,
  pressureMax: 1000,
  dotSize: 1,
} as const;

export function emptyProfile(name = ''): Profile {
  return {
    version: 1,
    name,
    deviceType: 'custom',
    matrix: { rows: PROFILE_DEFAULTS.rows, cols: PROFILE_DEFAULTS.cols },
    activeRows: [],
    activeCols: [],
    background: { imageData: '', aspectRatio: 1 },
    sensors: [],
    display: { mode: '3d', pressureMin: PROFILE_DEFAULTS.pressureMin, pressureMax: PROFILE_DEFAULTS.pressureMax, dotSize: PROFILE_DEFAULTS.dotSize },
    notes: '',
  };
}

/** The Desktop's stream label: row-major index 0 is "P1". */
export function sensorLabel(index: number): string {
  return `P${index + 1}`;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberOr(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function intList(value: unknown): number[] {
  return Array.isArray(value) ? value.map(Number).filter(Number.isFinite) : [];
}

/** Any JSON value → a complete Profile (the Desktop's normalizeProfile), keeping unknown fields. */
export function normalizeProfile(data: unknown): Profile {
  const raw = obj(data);
  const matrix = obj(raw.matrix);
  const background = obj(raw.background);
  const display = obj(raw.display);
  const sensors = Array.isArray(raw.sensors) ? raw.sensors : [];
  const pressureMin = numberOr(display.pressureMin ?? display.pressure_min, PROFILE_DEFAULTS.pressureMin);
  const pressureMax = numberOr(display.pressureMax ?? display.pressure_max, PROFILE_DEFAULTS.pressureMax);
  return {
    ...raw,
    version: Math.max(1, Math.floor(numberOr(raw.version, 1))),
    name: String(raw.name ?? ''),
    deviceType: String(raw.deviceType ?? 'custom'),
    matrix: {
      ...matrix,
      rows: Math.max(1, Math.floor(numberOr(matrix.rows, PROFILE_DEFAULTS.rows))),
      cols: Math.max(1, Math.floor(numberOr(matrix.cols, PROFILE_DEFAULTS.cols))),
    },
    activeRows: intList(raw.activeRows),
    activeCols: intList(raw.activeCols),
    background: {
      ...background,
      imageData: String(background.imageData ?? ''),
      aspectRatio: Math.max(0.01, numberOr(background.aspectRatio, 1)),
    },
    sensors: sensors.map((rawSensor, position) => {
      const sensor = obj(rawSensor);
      const index = Math.max(0, Math.floor(numberOr(sensor.index, position)));
      return {
        ...sensor,
        index,
        x: clamp(numberOr(sensor.x, 0.5), 0, 1),
        y: clamp(numberOr(sensor.y, 0.5), 0, 1),
        label: String(sensor.label ?? sensorLabel(index)),
        enabled: sensor.enabled !== false,
      };
    }),
    display: {
      ...display,
      mode: display.mode === '2d' ? '2d' : '3d',
      pressureMin,
      pressureMax: Math.max(pressureMax, pressureMin + 1),
      dotSize: clamp(numberOr(display.dotSize ?? display.dot_size, PROFILE_DEFAULTS.dotSize), 0.5, 4),
    },
    notes: String(raw.notes ?? ''),
  };
}

/** What gets written (the Desktop's serializeProfile, plus unknown fields): ratios to 6 places, dotSize to 2. */
export function serializeProfile(profile: Profile): Profile {
  const p = normalizeProfile(profile);
  return {
    ...p,
    sensors: p.sensors.map((s) => ({ ...s, x: round(s.x, 6), y: round(s.y, 6) })),
    display: { ...p.display, dotSize: round(p.display.dotSize, 2) },
  };
}

/** The file name stem the Desktop backend uses (_sanitize_name / sanitize_profile_name). */
export function sanitizeProfileName(value: string): string {
  const text = (value ?? '').trim() || 'profile';
  return Array.from(text, (ch) => (/^[\p{L}\p{N}_-]$/u.test(ch) ? ch : '_')).join('');
}

/** A new profile's key from what the user typed (the Desktop's profileKeyFromName). */
export function profileKeyFromName(value: string): string {
  return (value || 'new_profile').trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '_') || 'new_profile';
}

const SAFE_NAME = /^[A-Za-z0-9_-]{1,128}$/;
/** A stored profile name is a safe file stem (never a path). */
export function isProfileName(value: unknown): value is string {
  return typeof value === 'string' && SAFE_NAME.test(value);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/**
 * The file text as the Desktop backend writes it: json.dumps(indent=2,
 * sort_keys=True), ASCII only (ensure_ascii). Python writes 1.0 where this
 * writes 1; both read either.
 */
export function stringifyProfile(profile: Profile): string {
  const text = JSON.stringify(sortKeys(serializeProfile(profile)), null, 2);
  return text.replace(/[\u007f-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** The legacy (pre-backend) layout: no matrix block; shape comes from a "_<rows>_<cols>" name suffix. */
export function isLegacyProfile(data: unknown): boolean {
  const raw = obj(data);
  return !('matrix' in raw) && Array.isArray(raw.sensors);
}

/** profile_import.py's normalize_legacy_profile. */
export function normalizeLegacyProfile(data: unknown, stem: string): Profile {
  const raw = obj(data);
  const lowered = stem.toLowerCase();
  const deviceType = lowered.includes('glove') ? 'glove' : lowered.includes('insole') ? 'insole' : 'custom';
  const match = /_(\d+)_(\d+)$/.exec(stem);
  const rows = match ? Math.max(1, Number(match[1])) : PROFILE_DEFAULTS.rows;
  const cols = match ? Math.max(1, Number(match[2])) : PROFILE_DEFAULTS.cols;
  const p = normalizeProfile({ ...raw, matrix: { rows, cols }, name: raw.name || stem, deviceType: raw.deviceType || deviceType });
  return { ...p, display: { ...p.display, mode: obj(raw.display).mode === '2d' ? '2d' : '3d' } };
}

/** Parse a file's text; legacy profiles are converted. Throws "invalid_profile". */
export function parseProfileText(text: string, stem: string): Profile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('invalid_profile');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid_profile');
  return isLegacyProfile(data) ? normalizeLegacyProfile(data, stem) : normalizeProfile(data);
}
