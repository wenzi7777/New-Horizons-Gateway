// The phone's network state feeds the sync policy ("wifi_only" holds back on a metered network).
import { describe, expect, it } from 'vitest';

import { networkReader } from '../src/host/sync';

describe('networkReader', () => {
  it('passes Android\'s state through', () => {
    expect(networkReader({ networkState: () => ({ online: true, metered: true }) })()).toEqual({ online: true, metered: true });
    expect(networkReader({ networkState: () => ({ online: false, metered: false }) })()).toEqual({ online: false, metered: false });
  });

  it('counts unknown as online and not known to be metered', () => {
    expect(networkReader(null)()).toEqual({ online: true, metered: null });
    expect(networkReader({})()).toEqual({ online: true, metered: null });
    expect(
      networkReader({
        networkState: () => {
          throw new Error('gone');
        },
      })(),
    ).toEqual({ online: true, metered: null });
  });
});
