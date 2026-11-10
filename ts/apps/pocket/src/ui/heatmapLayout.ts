// Pure layout of the 2D heat map, the same numbers as the Desktop
// Visualization canvas (VisualizationPage.tsx draw()): 2 px gap, rounded
// cells, P labels in the corner when the cell is >= 24x16, values when
// >= 34x22, height = width * rows/cols clamped to 220..520.

export const HEATMAP_GAP = 2;
/** The Desktop canvas background and cell value ink. */
export const HEATMAP_BG = '#101317';
export const HEATMAP_VALUE_INK = '#101317';

/** P-numbering as the Desktop (lib/sensorLabel.ts): row-major, from P1, the CSV's columns. */
export function streamSensorLabel(rowMajorIndex: number): string {
  return `P${rowMajorIndex + 1}`;
}

export type HeatmapLayout = {
  width: number;
  height: number;
  cellW: number;
  cellH: number;
  radius: number;
  showText: boolean;
  showLabels: boolean;
  valueFont: number;
  labelFont: number;
};

export function heatmapLayout(width: number, rows: number, cols: number, maxHeight?: number): HeatmapLayout {
  const r = Math.max(rows, 1);
  const c = Math.max(cols, 1);
  let w = Math.max(width, 1);
  let h = Math.max(220, Math.min(520, (w * r) / c));
  if (maxHeight && h > maxHeight) {
    // Keep the cells' shape: shrink the width with the height.
    w = Math.max(1, (w * maxHeight) / h);
    h = maxHeight;
  }
  const cellW = Math.max(1, (w - HEATMAP_GAP * (c + 1)) / c);
  const cellH = Math.max(1, (h - HEATMAP_GAP * (r + 1)) / r);
  return {
    width: w,
    height: h,
    cellW,
    cellH,
    radius: Math.min(6, cellW * 0.18, cellH * 0.18),
    showText: cellW >= 34 && cellH >= 22,
    showLabels: cellW >= 24 && cellH >= 16,
    valueFont: Math.max(9, Math.min(12, cellW * 0.28)),
    labelFont: Math.max(8, Math.min(10, cellW * 0.2)),
  };
}

export function cellOrigin(layout: HeatmapLayout, row: number, col: number): { x: number; y: number } {
  return { x: HEATMAP_GAP + col * (layout.cellW + HEATMAP_GAP), y: HEATMAP_GAP + row * (layout.cellH + HEATMAP_GAP) };
}

/** Which cell (row-major index) a tap at (x, y) hits; null in the gaps or outside. */
export function cellAt(layout: HeatmapLayout, rows: number, cols: number, x: number, y: number): number | null {
  const pitchX = layout.cellW + HEATMAP_GAP;
  const pitchY = layout.cellH + HEATMAP_GAP;
  const col = Math.floor((x - HEATMAP_GAP) / pitchX);
  const row = Math.floor((y - HEATMAP_GAP) / pitchY);
  if (col < 0 || row < 0 || col >= cols || row >= rows) return null;
  // Taps in the 2 px gap snap to the nearest cell: a finger is wider than the gap.
  return row * cols + col;
}

/** Value as the Desktop prints it in a cell: one decimal. */
export function cellValueText(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : '0.0';
}
