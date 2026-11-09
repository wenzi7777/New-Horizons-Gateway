import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  LAB_LOCATION,
  MODES,
  THEME_LAST_KEY,
  THEME_MODE_KEY,
  daylightAt,
  nextMode,
  nextThemeChange,
  parseMode,
  resolveTheme,
  sunEvent,
} from '../src/theme';

// The expected values come from running the originals, not from hand:
// the Gateway web UI's theme.js (in a sandbox) and the Desktop's sunTimes.ts.
const GATEWAY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const THEME_JS = resolve(GATEWAY_ROOT, 'ts/packages/node/webui/theme.js');
const DESKTOP_SUN = resolve(GATEWAY_ROOT, '../New-Horizons-Desktop/frontend/src/lib/sunTimes.ts');

type SunEvent = (date: Date, rising: boolean) => Date | null;

function loadThemeJs(): SunEvent {
  const window: Record<string, unknown> = {
    localStorage: { getItem: () => null, setItem: () => undefined },
  };
  runInNewContext(readFileSync(THEME_JS, 'utf8'), { window });
  return (window.NHGTheme as { sunEvent: SunEvent }).sunEvent;
}

const DATES = [
  '2026-01-01T12:00:00+09:00',
  '2026-03-20T12:00:00+09:00',
  '2026-06-21T12:00:00+09:00',
  '2026-09-23T12:00:00+09:00',
  '2026-11-09T12:00:00+09:00',
  '2026-12-22T12:00:00+09:00',
  '2028-02-29T12:00:00+09:00',
];

let savedTz: string | undefined;
beforeAll(() => {
  savedTz = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo'; // the lab's local day, as on the lab's machines
});
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

const at = (iso: string) => new Date(iso);
const jst = (d: Date | null) => d && new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(11, 16);

describe('sun times', () => {
  it('match the web UI theme.js exactly', () => {
    const original = loadThemeJs();
    for (const iso of DATES) {
      for (const rising of [true, false]) {
        expect(sunEvent(at(iso), rising)?.getTime()).toBe(original(at(iso), rising)?.getTime());
      }
    }
  });

  it.skipIf(!existsSync(DESKTOP_SUN))('match the Desktop sunTimes.ts exactly', async () => {
    const desktop = (await import(/* @vite-ignore */ pathToFileURL(DESKTOP_SUN).href)) as {
      sunEvent: SunEvent;
      daylightAt: typeof daylightAt;
      LAB_LOCATION: typeof LAB_LOCATION;
    };
    expect(desktop.LAB_LOCATION).toEqual(LAB_LOCATION);
    for (const iso of DATES) {
      for (const rising of [true, false]) {
        expect(sunEvent(at(iso), rising)?.getTime()).toBe(desktop.sunEvent(at(iso), rising)?.getTime());
      }
      for (const hour of ['00:30', '05:00', '12:00', '18:00', '23:59']) {
        const now = at(iso.replace('12:00', hour));
        const mine = daylightAt(now);
        const theirs = desktop.daylightAt(now);
        expect(mine.day).toBe(theirs.day);
        expect(mine.nextChange?.getTime()).toBe(theirs.nextChange?.getTime());
      }
    }
  });

  it('are near the almanac (as the Desktop test checks)', () => {
    const summer = at('2026-06-21T12:00:00+09:00');
    const winter = at('2026-12-22T12:00:00+09:00');
    const near = (d: Date | null, hhmm: string) => {
      const [h, m] = jst(d)!.split(':').map(Number);
      const [eh, em] = hhmm.split(':').map(Number);
      expect(Math.abs(h! * 60 + m! - (eh! * 60 + em!))).toBeLessThanOrEqual(4);
    };
    near(sunEvent(summer, true), '04:20');
    near(sunEvent(summer, false), '19:07');
    near(sunEvent(winter, true), '06:55');
    near(sunEvent(winter, false), '16:28');
  });

  it('return null on polar night', () => {
    expect(sunEvent(at('2026-12-21T12:00:00+09:00'), true, { latitude: 80, longitude: 0 })).toBeNull();
    expect(daylightAt(at('2026-12-21T12:00:00+09:00'), { latitude: 80, longitude: 0 })).toEqual({ day: true, nextChange: null });
  });
});

describe('resolveTheme', () => {
  it('follows the sun in auto across a day boundary', () => {
    const evening = at('2026-11-09T22:00:00+09:00');
    const afterMidnight = at('2026-11-10T00:30:00+09:00');
    const tomorrowSunrise = sunEvent(afterMidnight, true)!;
    expect(resolveTheme('auto', evening)).toBe('dark');
    expect(resolveTheme('auto', afterMidnight)).toBe('dark');
    // Before midnight, the next change is already tomorrow's sunrise, and
    // after midnight it is the same moment.
    expect(daylightAt(evening).nextChange?.getTime()).toBe(tomorrowSunrise.getTime());
    expect(daylightAt(afterMidnight).nextChange?.getTime()).toBe(tomorrowSunrise.getTime());
    expect(resolveTheme('auto', new Date(tomorrowSunrise.getTime() - 1))).toBe('dark');
    expect(resolveTheme('auto', tomorrowSunrise)).toBe('light');
    const sunset = sunEvent(afterMidnight, false)!;
    expect(daylightAt(tomorrowSunrise).nextChange?.getTime()).toBe(sunset.getTime());
    expect(resolveTheme('auto', new Date(sunset.getTime() - 1))).toBe('light');
    expect(resolveTheme('auto', sunset)).toBe('dark');
  });

  it('keeps fixed modes and reports no next change for them', () => {
    const night = at('2026-11-09T22:00:00+09:00');
    expect(resolveTheme('light', night)).toBe('light');
    expect(resolveTheme('dark', at('2026-11-09T12:00:00+09:00'))).toBe('dark');
    expect(nextThemeChange('light', night)).toBeNull();
    expect(nextThemeChange('auto', night)).not.toBeNull();
  });

  it('modes and storage keys match the web UI and Desktop', () => {
    expect(MODES).toEqual(['auto', 'light', 'dark']);
    expect(THEME_MODE_KEY).toBe('nh-theme-mode');
    expect(THEME_LAST_KEY).toBe('nh-theme-last');
    expect(nextMode('auto')).toBe('light');
    expect(nextMode('dark')).toBe('auto');
    expect(parseMode('dark')).toBe('dark');
    expect(parseMode('sepia')).toBe('auto');
    expect(parseMode(null)).toBe('auto');
  });
});
