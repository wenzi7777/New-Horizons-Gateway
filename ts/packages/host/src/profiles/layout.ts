// Where a profile's sensors land on screen and in 3D (the Desktop's
// lib/profileLayout.ts), plus the stage maths of the profile editor.

import { clamp, type Profile, type ProfileSensor } from './format';

export type FittedProfileRect = {
  containerWidth: number;
  containerHeight: number;
  drawWidth: number;
  drawHeight: number;
  offsetX: number;
  offsetY: number;
  aspectRatio: number;
};

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

/** The largest rect of the given aspect (width / height) centred in the container. */
export function fitProfileRect(containerWidth: number, containerHeight: number, aspectRatio: number): FittedProfileRect {
  const safeWidth = Math.max(0, containerWidth);
  const safeHeight = Math.max(0, containerHeight);
  const safeAspectRatio = Math.max(0.01, aspectRatio || 1);
  if (safeWidth <= 0 || safeHeight <= 0) {
    return { containerWidth: safeWidth, containerHeight: safeHeight, drawWidth: 0, drawHeight: 0, offsetX: 0, offsetY: 0, aspectRatio: safeAspectRatio };
  }
  const containerRatio = safeWidth / safeHeight;
  const drawWidth = containerRatio > safeAspectRatio ? safeHeight * safeAspectRatio : safeWidth;
  const drawHeight = drawWidth / safeAspectRatio;
  return {
    containerWidth: safeWidth,
    containerHeight: safeHeight,
    drawWidth,
    drawHeight,
    offsetX: (safeWidth - drawWidth) / 2,
    offsetY: (safeHeight - drawHeight) / 2,
    aspectRatio: safeAspectRatio,
  };
}

export function profilePointToScreen(xRatio: number, yRatio: number, rect: FittedProfileRect): { left: number; top: number } {
  return { left: rect.offsetX + clampRatio(xRatio) * rect.drawWidth, top: rect.offsetY + clampRatio(yRatio) * rect.drawHeight };
}

export function profilePointToWorld(xRatio: number, yRatio: number, planeWidth: number, planeHeight: number): { worldX: number; worldZ: number } {
  return { worldX: (clampRatio(xRatio) - 0.5) * planeWidth, worldZ: (clampRatio(yRatio) - 0.5) * planeHeight };
}

/** The sensor within `radius` (ratio units, Desktop: 0.045) of a point, nearest first; -1 if none. */
export function nearestSensorIndex(sensors: readonly Pick<ProfileSensor, 'x' | 'y'>[], x: number, y: number, radius = 0.045): number {
  let best = -1;
  let bestDistance = Infinity;
  sensors.forEach((s, i) => {
    const d = Math.hypot(s.x - x, s.y - y);
    if (d < bestDistance) {
      best = i;
      bestDistance = d;
    }
  });
  return bestDistance <= radius ? best : -1;
}

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 12;
export function clampZoom(value: number): number {
  return clamp(value, MIN_ZOOM, MAX_ZOOM);
}

export type StageView = { zoom: number; panX: number; panY: number };

/**
 * Zoom by `factor` keeping the point (px, py) — relative to the stage's
 * untransformed origin — under the cursor (the Desktop's zoomAt).
 */
export function zoomStageAt(view: StageView, px: number, py: number, factor: number): StageView {
  const zoom = clampZoom(view.zoom * factor);
  const applied = zoom / view.zoom;
  return { zoom, panX: px - (px - view.panX) * applied, panY: py - (py - view.panY) * applied };
}

/** Move ratios by a nudge, clamped to the image. */
export function nudge(x: number, y: number, dx: number, dy: number): { x: number; y: number } {
  return { x: clamp(x + dx, 0, 1), y: clamp(y + dy, 0, 1) };
}

export type ProfilePoint = { index: number; value: number; xRatio: number; yRatio: number; label: string };

/**
 * The points Live draws for a frame (the Desktop's buildMatrixView with a
 * profile): each enabled sensor whose index exists in the frame, at its
 * profile position. Empty when the profile places nothing (draw the grid).
 */
export function profilePoints(profile: Pick<Profile, 'sensors'> | null | undefined, values: readonly number[] | null, frameLength = values?.length ?? Infinity): ProfilePoint[] {
  if (!profile) return [];
  const out: ProfilePoint[] = [];
  for (const s of profile.sensors) {
    if (!s || s.enabled === false) continue;
    const index = Math.floor(Number(s.index));
    if (!(index >= 0) || index >= frameLength) continue;
    const v = values ? Number(values[index]) : NaN;
    out.push({ index, value: Number.isFinite(v) ? v : 0, xRatio: clampRatio(s.x), yRatio: clampRatio(s.y), label: String(s.label ?? `P${index + 1}`) });
  }
  return out;
}

/** 3D plane for a profile layout (the Desktop's profilePlaneDimensions): height = rows-1, width by aspect. */
export function profilePlane(rows: number, cols: number, aspectRatio: number | undefined): { planeWidth: number; planeHeight: number } {
  const gridWidth = Math.max(cols - 1, 1);
  const gridHeight = Math.max(rows - 1, 1);
  const aspect = Math.max(0.01, Number.isFinite(aspectRatio) && aspectRatio ? aspectRatio : gridWidth / gridHeight);
  return { planeWidth: gridHeight * aspect, planeHeight: gridHeight };
}
