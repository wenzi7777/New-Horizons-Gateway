import { describe, expect, it } from 'vitest';
import { brandIconShapes, type BrandApp } from '../src/brand';

const apps: BrandApp[] = ['studio', 'pocket'];

describe('brandIconShapes', () => {
  it.each(apps)('%s: every path is finite and every shape is painted', (app) => {
    for (const opts of [{}, { small: true }, { parts: 'foreground' as const }, { mono: '#ffffff' }]) {
      for (const s of brandIconShapes(app, opts)) {
        expect(s.d).not.toMatch(/NaN|Infinity/);
        expect(s.fill ?? s.stroke).toBeTruthy();
      }
    }
  });

  it.each(apps)('%s: the adaptive layers split the full icon', (app) => {
    const all = brandIconShapes(app);
    const bg = brandIconShapes(app, { parts: 'background' });
    const fg = brandIconShapes(app, { parts: 'foreground' });
    expect(bg).toHaveLength(1);
    expect(bg.length + fg.length).toBe(all.length);
  });

  it.each(apps)('%s: has a rising body for the About animation, and small drops the details', (app) => {
    expect(brandIconShapes(app).some((s) => s.layer === 'body')).toBe(true);
    expect(brandIconShapes(app, { small: true }).length).toBeLessThan(brandIconShapes(app).length);
  });
});
