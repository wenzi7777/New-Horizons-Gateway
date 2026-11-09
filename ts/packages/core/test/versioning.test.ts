import { describe, expect, it } from 'vitest';

import { compareVersions, isNewerVersion, isPrerelease, manifestUrlFor, normalizeChannel } from '../src/versioning';
import { hasFixtures, readFixture } from './fixtures';

type VersionsFixture = {
  compare: { a: string; b: string; order: number }[];
  prerelease: { version: string; prerelease: boolean }[];
};

describe.skipIf(!hasFixtures)('shared version vectors', () => {
  it('matches spec/fixtures/versions.json', () => {
    const fixture = readFixture<VersionsFixture>('versions.json');
    for (const c of fixture.compare) expect(Math.sign(compareVersions(c.a, c.b)), JSON.stringify(c)).toBe(c.order);
    for (const c of fixture.prerelease) expect(isPrerelease(c.version), JSON.stringify(c)).toBe(c.prerelease);
  });
});

describe('versioning', () => {
  it('sorts a beta below its release', () => {
    expect(compareVersions('v0.7.0-beta.1', 'v0.7.0')).toBeLessThan(0);
    expect(compareVersions('v0.7.0-beta.1', 'v0.6.9')).toBeGreaterThan(0);
    expect(isNewerVersion('v0.7.0', 'v0.7.0-beta.1')).toBe(true);
    expect(isNewerVersion('v0.7.0', 'v0.7.0')).toBe(false);
  });

  it('picks the channel manifest', () => {
    expect(manifestUrlFor('stable').endsWith('/releases/gateway-latest.json')).toBe(true);
    expect(manifestUrlFor('beta').endsWith('/releases/gateway-beta.json')).toBe(true);
    expect(manifestUrlFor('beta', 'https://x/y')).toBe('https://x/y-beta.json');
    expect(normalizeChannel('nightly')).toBe('stable');
    expect(normalizeChannel(null)).toBe('stable');
    expect(normalizeChannel('BETA')).toBe('beta');
    expect(normalizeChannel(' beta \n')).toBe('beta');
  });

  // Python re quirks the TS regex reproduces.
  it('parses like Python re: trailing newline, build metadata, garbage', () => {
    expect(compareVersions('v1.2.3+build\n', 'v1.2.3')).toBe(0);
    expect(compareVersions('v1.2.3\n', '1.2.3')).toBe(0);
    expect(compareVersions('v1.2.3\n\n', 'v1.2.3')).toBe(0); // [^-+]* swallows newlines
    expect(compareVersions('v1.2.3+b\n\n', 'v0.0.0')).toBe(0); // `.` stops at \n: no match -> 0.0.0
    expect(compareVersions('v1.2.3+b\r', 'v1.2.3')).toBe(0); // Python `.` matches \r
    expect(compareVersions('v1.2.3-rc\n', 'v1.2.3-rc')).toBe(1); // the prerelease keeps its \n
    expect(compareVersions('garbage', null)).toBe(0);
    expect(compareVersions('v2', 'v1.9.9')).toBeGreaterThan(0);
    expect(isPrerelease('v1.0.0+meta')).toBe(false);
    expect(isPrerelease('v1.0.0-rc.1+meta')).toBe(true);
    expect(compareVersions('v1.0.0-rc.1+a', 'v1.0.0-rc.1+b')).toBe(0);
  });
});
