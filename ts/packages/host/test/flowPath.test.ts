import { describe, expect, it } from 'vitest';
import { connectionFlow, estimateTextWidth, fitMiddle, flowCellWidth, flowLayout, powerFlow } from '../src/flowPath';

const lit = (graph: NonNullable<ReturnType<typeof powerFlow>>) => graph.edges.filter((e) => e.active).map((e) => `${e.from}>${e.to}`).sort();

describe('powerFlow', () => {
  it('is null when nothing is reported', () => {
    expect(powerFlow({ chargerPresent: null, chargeState: '-' })).toBeNull();
    expect(powerFlow({ chargerPresent: null, chargeState: '' })).toBeNull();
  });
  it('lights USB to system and into the battery while charging', () => {
    expect(lit(powerFlow({ chargerPresent: true, chargeState: 'charging' })!)).toEqual(['charger>battery', 'charger>system', 'usb>charger']);
  });
  it('leaves the battery out once it is full', () => {
    expect(lit(powerFlow({ chargerPresent: true, chargeState: 'charge_done' })!)).toEqual(['charger>system', 'usb>charger']);
  });
  it('runs from the battery without USB', () => {
    const graph = powerFlow({ chargerPresent: false, chargeState: 'not_charging' })!;
    expect(lit(graph)).toEqual(['battery>system']);
    expect(graph.nodes.find((n) => n.id === 'usb')?.active).toBe(false);
  });
  it('infers USB from the charge state on older firmware', () => {
    expect(lit(powerFlow({ chargerPresent: null, chargeState: 'charging' })!)).toContain('usb>charger');
  });
});

describe('connectionFlow', () => {
  it('uses a Hub node over ESP-NOW', () => {
    expect(connectionFlow({ link: 'espnow', deviceOnline: true, upstreamOnline: null }).nodes.map((n) => n.id)).toEqual(['device', 'hub', 'server']);
  });
  it('stops at the relay when it has no server', () => {
    const graph = connectionFlow({ link: 'wifi', deviceOnline: true, upstreamOnline: false });
    expect(graph.edges.map((e) => e.active)).toEqual([true, false]);
  });
  it('is all dark when the device is offline', () => {
    expect(connectionFlow({ link: 'wifi', deviceOnline: false, upstreamOnline: true }).edges.every((e) => !e.active)).toBe(true);
  });
});

describe('flowLayout', () => {
  it('bends the battery wire up into the system box', () => {
    const layout = flowLayout(powerFlow({ chargerPresent: false, chargeState: 'not_charging' })!);
    const wire = layout.wires.find((w) => w.from === 'battery')!;
    const system = layout.boxes.find((b) => b.id === 'system')!;
    expect(wire.points).toHaveLength(3);
    expect(wire.points[2]).toEqual([system.x + system.w / 2, system.y + system.h]);
    for (const box of layout.boxes) {
      expect(box.x + box.w).toBeLessThanOrEqual(layout.width);
      expect(box.y + box.h).toBeLessThanOrEqual(layout.height);
    }
  });
});

describe('flow box text', () => {
  it('widens the boxes to fit a device name', () => {
    const narrow = flowCellWidth([{ title: 'Server', value: 'Online' }]);
    const wide = flowCellWidth([{ title: 'Device', value: 'NHOS-90DA725B795C' }]);
    expect(narrow).toBe(112);
    expect(wide).toBeGreaterThan(narrow);
    expect(wide).toBeLessThanOrEqual(200);
    expect(estimateTextWidth('NHOS-90DA725B795C', 13) * 1.08 + 24).toBeLessThanOrEqual(wide);
  });
  it('cuts in the middle only when it must', () => {
    expect(fitMiddle('Online', 100, 13)).toBe('Online');
    const cut = fitMiddle('NHOS-90DA725B795C', 80, 12.5);
    expect(cut).toContain('…');
    expect(cut.startsWith('NHOS')).toBe(true);
    expect(cut.endsWith('95C')).toBe(true);
    expect(estimateTextWidth(cut, 12.5)).toBeLessThanOrEqual(80);
  });
  it('counts CJK as wider', () => {
    expect(estimateTextWidth('充電中', 13)).toBeGreaterThan(estimateTextWidth('abc', 13));
  });
});
