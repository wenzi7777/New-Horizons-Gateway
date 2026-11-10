import { existsSync, readFileSync } from 'node:fs';
import { it, expect } from 'vitest';
import { parseProfileText, stringifyProfile } from '../src/profiles';
it.skipIf(!existsSync('/Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop/data/profiles'))('round-trips the Desktop sample profiles', () => {
  for (const f of ['RightGlove_5_5','LeftInsole_5_7']) {
    const t = readFileSync(`/Users/nickxu/Documents/vd-ctl-r-os-lts/New-Horizons-Desktop/data/profiles/${f}.json`, 'utf8');
    const out = stringifyProfile(parseProfileText(t, f));
    expect(JSON.parse(out)).toEqual(JSON.parse(t));
    console.log(f, t.trim() === out.trim() ? 'byte-identical' : 'differs textually');
  }
});
