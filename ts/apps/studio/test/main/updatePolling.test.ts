import { describe, expect, it } from 'vitest';

import { shouldRecheckUpdate, UPDATE_RECHECK_MS } from '../../src/main/areas/app';

describe('periodic update check', () => {
  const now = 10 * UPDATE_RECHECK_MS;
  it('checks when never checked or the last check is old', () => {
    expect(shouldRecheckUpdate('idle', null, now)).toBe(true);
    expect(shouldRecheckUpdate('current', now - UPDATE_RECHECK_MS, now)).toBe(true);
    expect(shouldRecheckUpdate('error', now - UPDATE_RECHECK_MS - 1, now)).toBe(true);
  });
  it('waits while the last check is recent', () => {
    expect(shouldRecheckUpdate('current', now - 60_000, now)).toBe(false);
    expect(shouldRecheckUpdate('available', now - UPDATE_RECHECK_MS + 1, now)).toBe(false);
  });
  it('never interrupts a download, verification, install or check', () => {
    for (const phase of ['checking', 'downloading', 'verifying', 'ready', 'installing']) expect(shouldRecheckUpdate(phase, null, now)).toBe(false);
  });
});
