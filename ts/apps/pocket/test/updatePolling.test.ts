import { describe, expect, it } from 'vitest';

import { shouldRecheckUpdate, UPDATE_RECHECK_MS } from '../src/host/updater';

describe('periodic update check', () => {
  const now = 10 * UPDATE_RECHECK_MS;
  it('checks when never checked or the last check is old', () => {
    expect(shouldRecheckUpdate('idle', 0, now)).toBe(true);
    expect(shouldRecheckUpdate('upToDate', now - UPDATE_RECHECK_MS, now)).toBe(true);
    expect(shouldRecheckUpdate('error', now - UPDATE_RECHECK_MS - 1, now)).toBe(true);
  });
  it('waits while the last check is recent', () => {
    expect(shouldRecheckUpdate('upToDate', now - 60_000, now)).toBe(false);
  });
  it('never interrupts a check, download, permission step or install', () => {
    for (const phase of ['checking', 'downloading', 'needsPermission', 'installing']) expect(shouldRecheckUpdate(phase, 0, now)).toBe(false);
  });
});
