import { describe, expect, it } from 'vitest';

import { initialIndex, selectedLabel, selectKey } from '../../src/ui/components/selectLogic';
import { cellAt, cellOrigin, cellValueText, heatmapLayout, streamSensorLabel } from '../../src/ui/heatmapLayout';

const opts = [
  { value: 'system', label: 'System' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語', disabled: true },
  { value: 'zh-CN', label: '简体中文' },
];

describe('Select logic', () => {
  it('starts on the chosen option, else the first enabled', () => {
    expect(initialIndex(opts, 'zh-CN')).toBe(3);
    expect(initialIndex(opts, 'xx')).toBe(0);
    expect(initialIndex(opts, 'ja')).toBe(0);
  });
  it('arrows wrap and skip disabled; Home/End', () => {
    expect(selectKey(opts, 1, 'ArrowDown').index).toBe(3);
    expect(selectKey(opts, 3, 'ArrowDown').index).toBe(0);
    expect(selectKey(opts, 0, 'ArrowUp').index).toBe(3);
    expect(selectKey(opts, 3, 'ArrowUp').index).toBe(1);
    expect(selectKey(opts, 2, 'Home').index).toBe(0);
    expect(selectKey(opts, 0, 'End').index).toBe(3);
  });
  it('Enter/Space choose, Escape closes, others ignored', () => {
    expect(selectKey(opts, 1, 'Enter')).toEqual({ index: 1, action: 'choose' });
    expect(selectKey(opts, 1, ' ').action).toBe('choose');
    expect(selectKey(opts, 2, 'Enter').action).toBe('none');
    expect(selectKey(opts, 1, 'Escape').action).toBe('close');
    expect(selectKey(opts, 1, 'a')).toEqual({ index: 1, action: 'none' });
    expect(selectKey([], -1, 'ArrowDown').index).toBe(-1);
  });
  it('labels the chosen value', () => {
    expect(selectedLabel(opts, 'en')).toBe('English');
    expect(selectedLabel(opts, 'xx', 'Choose')).toBe('Choose');
  });
});

describe('heat map layout (Desktop Visualization 2D)', () => {
  it('numbers sensors row-major from P1', () => {
    expect(streamSensorLabel(0)).toBe('P1');
    expect(streamSensorLabel(14)).toBe('P15');
  });
  it('sizes like the Desktop canvas', () => {
    const l = heatmapLayout(362, 5, 7);
    expect(l.height).toBeCloseTo(Math.max(220, (362 * 5) / 7));
    expect(l.cellW).toBeCloseTo((362 - 2 * 8) / 7);
    expect(l.showText).toBe(true);
    expect(l.showLabels).toBe(true);
    expect(heatmapLayout(2000, 1, 1).height).toBe(520);
    const dense = heatmapLayout(450, 15, 15);
    expect(dense.showText).toBe(false);
    expect(dense.showLabels).toBe(true);
    expect(heatmapLayout(200, 15, 15).showLabels).toBe(false);
  });
  it('caps the height and keeps the cell shape', () => {
    const l = heatmapLayout(400, 10, 4, 300);
    expect(l.height).toBe(300);
    expect(l.width).toBeCloseTo(400 * (300 / 520));
  });
  it('hit-tests taps back to the cell', () => {
    const l = heatmapLayout(362, 5, 7);
    const o = cellOrigin(l, 2, 3);
    expect(cellAt(l, 5, 7, o.x + 1, o.y + 1)).toBe(2 * 7 + 3);
    expect(cellAt(l, 5, 7, -5, 10)).toBeNull();
    expect(cellAt(l, 5, 7, l.width + 5, 10)).toBeNull();
  });
  it('prints one decimal', () => {
    expect(cellValueText(1234.56)).toBe('1234.6');
    expect(cellValueText(Number.NaN)).toBe('0.0');
  });
});
