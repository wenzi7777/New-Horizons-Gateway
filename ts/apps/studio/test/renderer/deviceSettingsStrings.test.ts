import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DEVICE_SETTINGS_STRINGS } from '../../src/renderer/pages/device/settingsStrings';
import { DEVICE_SETTINGS_SECTIONS } from '../../src/renderer/pages/device/DeviceSettings';
import { actionButtonActionsForGesture } from '../../src/renderer/lib/actionButton';

const en = DEVICE_SETTINGS_STRINGS.en as Record<string, string>;

describe('device settings strings (ported from the Desktop)', () => {
  it('every language has every string, none empty', () => {
    const keys = Object.keys(en).sort();
    for (const locale of ['ja', 'zh-CN'] as const) {
      const dict = DEVICE_SETTINGS_STRINGS[locale] as Record<string, string>;
      expect(Object.keys(dict).sort()).toEqual(keys);
      for (const key of keys) expect(dict[key], `${locale}.${key}`).not.toBe('');
    }
  });

  it('has every key the cards read, literal or built', () => {
    const source = readFileSync(new URL('../../src/renderer/pages/device/DeviceHardware.tsx', import.meta.url), 'utf8');
    const literal = [...source.matchAll(/ds\('([A-Za-z0-9_]+)'/g)].map((m) => m[1]!);
    const built = [
      ...DEVICE_SETTINGS_SECTIONS.map((id) => `settingsSection_${id}`),
      ...actionButtonActionsForGesture('long').flatMap((a) => [`actionButtonAction_${a}`, `actionButtonActionCopy_${a}`]),
      ...['system_status', 'connectivity', 'pressure_meter', 'stream_heartbeat', 'calibration_auto', 'solid_marker', 'identify', 'off', 'app'].map((p) => `indicatorPreset_${p}`),
      ...['live_status', 'sensor_snapshot', 'recording_status', 'app'].map((p) => `oledPage_${p}`),
    ];
    for (const key of [...literal, ...built]) expect(en[key], key).toBeTruthy();
  });
});
