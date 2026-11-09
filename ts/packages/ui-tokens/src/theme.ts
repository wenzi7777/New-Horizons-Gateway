// Light or dark, decided the way the Desktop app decides it
// (New-Horizons-Desktop/frontend/src/lib/theme.tsx + sunTimes.ts, and the
// Gateway web UI's vanilla port webui/theme.js): "auto" follows sunrise and
// sunset at the lab, "light"/"dark" are fixed.
//
// Pure functions only -- no timers, no storage, no DOM -- so the web UI,
// the terminal UI (Node) and the Android app (React Native) share them.
// Hosts re-check on their own schedule: the Desktop and the web UI re-run
// resolveTheme() once a minute (which also catches a machine waking from
// sleep), and `daylightAt().nextChange` says when the answer next flips.
//
// Calendar days are the host's local days (Date#getFullYear/getMonth/
// getDate), exactly as in the Desktop: on a device whose time zone is not
// Japan, "today's sunrise at the lab" is the one on that device's date.

export type ThemeMode = 'auto' | 'light' | 'dark';
export type Theme = 'light' | 'dark';
export type GeoLocation = { readonly latitude: number; readonly longitude: number };

/** The order a theme button cycles through, starting from the default. */
export const MODES: readonly ThemeMode[] = ['auto', 'light', 'dark'];
export const DEFAULT_MODE: ThemeMode = 'auto';

/** Where the chosen mode is remembered (localStorage in the web UI). */
export const THEME_MODE_KEY = 'nh-theme-mode';
/** The theme last shown, read before first paint so a night visit does not flash white. */
export const THEME_LAST_KEY = 'nh-theme-last';

/** The lab: Aizu-Wakamatsu, Fukushima. */
export const LAB_LOCATION: GeoLocation = { latitude: 37.5236, longitude: 139.9381 };

// Official sunrise/sunset: the sun's centre 50' below the horizon.
const ZENITH = 90.833;
const DAY_MS = 86_400_000;

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const wrap = (value: number, range: number) => ((value % range) + range) % range;

function dayOfYear(date: Date): number {
  const start = Date.UTC(date.getFullYear(), 0, 0);
  const today = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((today - start) / DAY_MS);
}

/** A stored value as a mode, or the default for anything unknown/missing. */
export function parseMode(stored: unknown): ThemeMode {
  return MODES.includes(stored as ThemeMode) ? (stored as ThemeMode) : DEFAULT_MODE;
}

/** The mode after `mode` in the cycle auto -> light -> dark -> auto. */
export function nextMode(mode: ThemeMode): ThemeMode {
  return MODES[(MODES.indexOf(mode) + 1) % MODES.length] ?? DEFAULT_MODE;
}

/**
 * Sunrise (`rising`) or sunset on `date`'s local calendar day, or null when
 * the sun does not rise or set that day (polar day/night). The usual almanac
 * algorithm, accurate to a minute or two.
 */
export function sunEvent(date: Date, rising: boolean, location: GeoLocation = LAB_LOCATION): Date | null {
  const { latitude, longitude } = location;
  const lngHour = longitude / 15;
  const t = dayOfYear(date) + ((rising ? 6 : 18) - lngHour) / 24;
  const meanAnomaly = 0.9856 * t - 3.289;
  const trueLongitude = wrap(
    meanAnomaly + 1.916 * Math.sin(rad(meanAnomaly)) + 0.02 * Math.sin(rad(2 * meanAnomaly)) + 282.634,
    360,
  );
  let rightAscension = wrap(deg(Math.atan(0.91764 * Math.tan(rad(trueLongitude)))), 360);
  rightAscension += Math.floor(trueLongitude / 90) * 90 - Math.floor(rightAscension / 90) * 90;
  rightAscension /= 15;
  const sinDec = 0.39782 * Math.sin(rad(trueLongitude));
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosHour = (Math.cos(rad(ZENITH)) - sinDec * Math.sin(rad(latitude))) / (cosDec * Math.cos(rad(latitude)));
  if (cosHour > 1 || cosHour < -1) return null;
  const hourAngle = (rising ? 360 - deg(Math.acos(cosHour)) : deg(Math.acos(cosHour))) / 15;
  const localMeanTime = hourAngle + rightAscension - 0.06571 * t - 6.622;
  const utcHours = wrap(localMeanTime - lngHour, 24);

  // UTC hours on the local day's UTC date can land on the neighbouring local
  // day (Japan's sunrise is the previous evening in UTC): pull it back in.
  const localMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  let when = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) + utcHours * 3_600_000;
  while (when < localMidnight) when += DAY_MS;
  while (when >= localMidnight + DAY_MS) when -= DAY_MS;
  return new Date(when);
}

/** Today's sunrise and sunset (local day of `date`). */
export function sunTimes(date: Date, location: GeoLocation = LAB_LOCATION): { sunrise: Date | null; sunset: Date | null } {
  return { sunrise: sunEvent(date, true, location), sunset: sunEvent(date, false, location) };
}

/** Whether it is daytime at `now`, and when that next changes (null: never, on polar day/night). */
export function daylightAt(now: Date, location: GeoLocation = LAB_LOCATION): { day: boolean; nextChange: Date | null } {
  const sunrise = sunEvent(now, true, location);
  const sunset = sunEvent(now, false, location);
  // Polar day or night never happens at the lab; stay light and do not switch.
  if (!sunrise || !sunset) return { day: true, nextChange: null };
  if (now < sunrise) return { day: false, nextChange: sunrise };
  if (now < sunset) return { day: true, nextChange: sunset };
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { day: false, nextChange: sunEvent(tomorrow, true, location) };
}

/** The theme to show: a fixed mode as is, "auto" light by day and dark by night. */
export function resolveTheme(mode: ThemeMode, now: Date, location: GeoLocation = LAB_LOCATION): Theme {
  if (mode !== 'auto') return mode;
  return daylightAt(now, location).day ? 'light' : 'dark';
}

/** In auto mode, when the theme next changes; otherwise null (what the theme button shows). */
export function nextThemeChange(mode: ThemeMode, now: Date, location: GeoLocation = LAB_LOCATION): Date | null {
  return mode === 'auto' ? daylightAt(now, location).nextChange : null;
}
