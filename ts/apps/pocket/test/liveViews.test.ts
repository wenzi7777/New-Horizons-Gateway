import { describe, expect, it } from 'vitest';

import { createLiveViews, DEFAULT_LIVE_VIEW, demoProfileText, LIVE_VIEWS_PATH, memoryFiles, normalizeLiveView } from '../src/host/liveViews';

describe('live views', () => {
  it('keeps each device view and restores it from the data folder', () => {
    const files = memoryFiles();
    const views = createLiveViews(files);
    expect(views.view('AA:BB')).toEqual(DEFAULT_LIVE_VIEW);
    views.setView('aa:bb', { transpose: true, mode: '3d', dotSize: 9 });
    expect(JSON.parse(files.readText(LIVE_VIEWS_PATH)!)).toHaveProperty('AABB');
    const again = createLiveViews(files);
    expect(again.view('AA-BB')).toMatchObject({ transpose: true, mode: '3d', dotSize: 4, rowMirror: false });
  });

  it('falls back to the defaults on unknown values', () => {
    expect(normalizeLiveView({ mode: 'x', profile: 3, dotSize: 'big' })).toEqual(DEFAULT_LIVE_VIEW);
  });

  it('lists the synced profiles and reads one', () => {
    const views = createLiveViews(memoryFiles({ 'profiles/demo-ring.json': demoProfileText(), 'profiles/broken.json': '{', 'profiles/sub/x.json': '{}' }));
    expect(views.profiles()).toEqual([{ name: 'demo-ring', displayName: 'Demo ring' }]);
    expect(views.profile('demo-ring')?.sensors).toHaveLength(8);
    expect(views.profile('missing')).toBeNull();
  });
});
