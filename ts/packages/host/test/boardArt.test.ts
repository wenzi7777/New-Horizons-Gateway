import { describe, expect, it } from 'vitest';

import { BOARD_ARTS, boardArtAnchor, boardArtBounds, boardArtFor, boardArtPins, calloutLayout, fpcContact, spreadLabels } from '../src/boardArt';
import { BOARD_PINS, boardPinsFor } from '../src/boardPins';
import { settingsFromConfig, configPatchFromSettings, hostDefaultConfig } from '../src/views';

const MODEL = { v10f: 'TIA-CTL v1.0.F 2026.4', v15f: 'TIA-CTL v1.5.F 2026.7', v20f: 'TIA-CTL v2.0.F 2026.10' } as const;

describe('boardArtFor', () => {
  it('draws the three NHOS Native boards, older spellings included', () => {
    expect(boardArtFor(MODEL.v10f)?.id).toBe('v10f');
    expect(boardArtFor(MODEL.v15f)?.id).toBe('v15f');
    expect(boardArtFor('VD-CTL/R v1.5.F 2026.7')?.id).toBe('v15f');
    expect(boardArtFor(MODEL.v20f)?.id).toBe('v20f');
  });

  it('has no drawing for GCU LTS or unknown boards', () => {
    for (const board of BOARD_PINS.filter((b) => b.hardwareModel.includes('GCU'))) expect(boardArtFor(board.hardwareModel)).toBeNull();
    expect(boardArtFor('something else')).toBeNull();
    expect(boardArtFor(null)).toBeNull();
  });
});

describe('board drawings', () => {
  for (const art of BOARD_ARTS) {
    const model = MODEL[art.id];
    it(`${art.id}: FPC contacts sit on the board and match boardPins`, () => {
      const pins = boardArtPins(art, model);
      const board = BOARD_PINS.find((b) => b.hardwareModel === model)!;
      expect(pins.length).toBe(board.analogPinSlots.length + board.digitalPinSlots.length);
      for (const pin of pins) {
        expect(pin.x).toBeGreaterThanOrEqual(0);
        expect(pin.x).toBeLessThanOrEqual(art.width);
        expect(pin.y).toBeGreaterThanOrEqual(0);
        expect(pin.y).toBeLessThanOrEqual(art.height);
      }
      // The first analog row is A0 on every one of these boards, at contact 1.
      const a0 = pins.find((p) => p.side === 'analog' && p.slot.label === 'A0')!;
      expect(a0).toMatchObject(art.analogFpc.pin1);
      // D0 is contact 1 of the digital FPC.
      const d0 = pins.find((p) => p.side === 'digital' && p.slot.label === 'D0')!;
      expect(d0).toMatchObject(art.digitalFpc.pin1);
    });

    it(`${art.id}: every callout target the apps use has an anchor inside the drawing`, () => {
      const bounds = boardArtBounds(art);
      for (const target of ['mcu', 'antenna', 'usb', 'battery', 'analogFpc', 'digitalFpc', 'led', 'power', 'imu', 'vref', 'tia', 'charger'] as const) {
        const anchor = boardArtAnchor(art, target);
        expect(anchor, target).not.toBeNull();
        expect(anchor!.x).toBeGreaterThanOrEqual(bounds.x);
        expect(anchor!.x).toBeLessThanOrEqual(bounds.x + bounds.width);
        expect(anchor!.y).toBeGreaterThanOrEqual(bounds.y);
        expect(anchor!.y).toBeLessThanOrEqual(bounds.y + bounds.height);
      }
    });
  }

  it('reverses the slot order where boardPins lists a connector from its last contact', () => {
    const fpc = { pin1: { x: 1, y: 10 }, step: { x: 0, y: -0.5 }, count: 20, slotsReversed: true };
    expect(fpcContact(fpc, 0)).toEqual({ x: 1, y: 0.5 }); // contact 20
    expect(fpcContact(fpc, 19)).toEqual({ x: 1, y: 10 }); // contact 1
  });
});

describe('calloutLayout', () => {
  const art = boardArtFor(MODEL.v20f)!;
  const options = { width: 720, labelWidth: 170, labelHeight: 52, maxBoardHeight: 340 };

  it('keeps the board between the label columns and every label inside the diagram', () => {
    const layout = calloutLayout(
      art,
      [
        { id: 'battery', target: 'battery' },
        { id: 'vref', target: 'vref' },
        { id: 'fps', target: 'analogFpc' },
        { id: 'link', target: 'antenna' },
        { id: 'fw', target: 'mcu' },
        { id: 'led', target: 'led' },
      ],
      options,
    );
    expect(layout.labels).toHaveLength(6);
    const boardW = layout.board.bounds.width * layout.board.scale;
    expect(layout.board.x).toBeGreaterThanOrEqual(options.labelWidth);
    expect(layout.board.x + boardW).toBeLessThanOrEqual(options.width - options.labelWidth);
    for (const label of layout.labels) {
      expect(label.y).toBeGreaterThanOrEqual(0);
      expect(label.y + label.h).toBeLessThanOrEqual(layout.height);
    }
    // Labels on one side never overlap.
    for (const side of ['left', 'right'] as const) {
      const ys = layout.labels.filter((l) => l.side === side).map((l) => l.y).sort((a, b) => a - b);
      for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(options.labelHeight - 1e-9);
    }
    // The battery (right of centre) goes right, the analog FPC (left edge) left.
    expect(layout.labels.find((l) => l.id === 'battery')!.side).toBe('right');
    expect(layout.labels.find((l) => l.id === 'fps')!.side).toBe('left');
  });

  it('leaves out callouts to parts the board does not have', () => {
    const v10f = boardArtFor(MODEL.v10f)!;
    const layout = calloutLayout(v10f, [{ id: 'gauge', target: 'fuelGauge' }, { id: 'usb', target: 'usb' }], options);
    expect(layout.labels.map((l) => l.id)).toEqual(['usb']);
  });

  it('spreads crowded labels apart and keeps them inside', () => {
    expect(spreadLabels([50, 50, 50], 20, 0, 200)).toEqual([40, 60, 80]);
    expect(spreadLabels([195, 195], 20, 0, 200)).toEqual([160, 180]);
  });
});

describe('uiStyle setting', () => {
  it('defaults to the illustrated interface and round-trips through the config', () => {
    const config = hostDefaultConfig('studio-12345678', 'NH Studio');
    expect(config.pocket_ui_style).toBe('modern');
    expect(configPatchFromSettings({ uiStyle: 'classic' })).toEqual({ pocket_ui_style: 'classic' });
  });

  it('reads unknown or missing values as modern', () => {
    const base = { gateway_id: 'x', gateway_name: 'x', target_mode: 'production', manual_url: '', offer_policy: 'managed' } as never;
    expect(settingsFromConfig(base).uiStyle).toBe('modern');
    expect(settingsFromConfig({ ...(base as object), pocket_ui_style: 'classic' } as never).uiStyle).toBe('classic');
    expect(settingsFromConfig({ ...(base as object), pocket_ui_style: 'odd' } as never).uiStyle).toBe('modern');
  });
});

describe('digital FPC labels match the PCB', () => {
  // v1.5.F / v2.0.F FPC2 (EasyEDA): contact 15 not connected, 16 SDA, 17 SCL, 18 GND.
  it.each(['TIA-CTL v1.5.F 2026.7', 'TIA-CTL v2.0.F 2026.10'])('%s', (model) => {
    const art = boardArtFor(model)!;
    const slots = boardPinsFor(model).digitalPinSlots;
    const labelAt = (contact: number) => slots[art.digitalFpc.slotsReversed ? art.digitalFpc.count - contact : contact - 1]?.label;
    expect([15, 16, 17, 18].map(labelAt)).toEqual(['NC', 'SDA', 'SCL', 'GND']);
    expect(slots.find((slot) => slot.label === 'SCL')?.gpio).toBe(42);
    expect(slots.find((slot) => slot.label === 'SDA')?.gpio).toBe(40);
  });
});

describe('branched callouts', () => {
  it('splits one label to both FPCs from the bend at the board edge', () => {
    const art = boardArtFor(MODEL.v20f)!;
    const layout = calloutLayout(art, [{ id: 'matrix', target: 'analogFpc', branches: ['digitalFpc'] }], { width: 600, labelWidth: 150, labelHeight: 60, maxBoardHeight: 300 });
    const leader = layout.leaders[0]!;
    expect(leader.branches).toHaveLength(1);
    const branch = leader.branches[0]!;
    expect(branch.points[0]).toEqual(leader.points[1]);
    expect(branch.points[1]![0]).toBe(leader.points[1]![0]);
    expect(branch.points[2]![1]).toBe(branch.points[1]![1]);
    expect(branch.anchor[0]).toBeGreaterThan(leader.anchor[0]);
  });
  it('has no branches by default', () => {
    const layout = calloutLayout(boardArtFor(MODEL.v15f)!, [{ id: 'mcu', target: 'mcu' }], { width: 600, labelWidth: 150, labelHeight: 60, maxBoardHeight: 300 });
    expect(layout.leaders[0]!.branches).toEqual([]);
  });
});
