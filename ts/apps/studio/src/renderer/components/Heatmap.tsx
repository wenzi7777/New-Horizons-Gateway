// 2D pressure heatmap on a canvas: one rounded cell per sensor, row-major,
// coloured with the Desktop's pressure scale. With a sensor-layout profile
// (areas/profiles) it draws the profile's background image and one dot per
// enabled sensor at its profile position instead (the Desktop's dot map).

import { useEffect, useRef } from 'react';

import { cssColorForValue, type PressureRange } from '../lib/pressureColor';
import { clamp, fitProfileRect, profilePoints, type Profile } from '../areas/profiles/model';

const imageCache = new Map<string, HTMLImageElement>();
function cachedImage(src: string, onLoad: () => void): HTMLImageElement | null {
  let img = imageCache.get(src);
  if (!img) {
    if (imageCache.size > 8) imageCache.clear();
    img = new Image();
    img.src = src;
    imageCache.set(src, img);
  }
  if (img.complete && img.naturalWidth > 0) return img;
  img.addEventListener('load', onLoad, { once: true });
  return null;
}

export function Heatmap({
  values,
  rows,
  cols,
  range,
  label,
  maxHeight,
  profile,
}: {
  values: readonly number[] | null;
  rows: number;
  cols: number;
  range: PressureRange;
  label: string;
  /** Cap on the drawn height in CSS px (the width follows the matrix aspect). */
  maxHeight?: number;
  /** A sensor-layout profile: draw its sensors over its background instead of the grid. */
  profile?: Pick<Profile, 'sensors' | 'background' | 'display'> | null;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  const usesProfile = Boolean(profile && profilePoints(profile, null, values?.length ?? Infinity).length);
  const latest = useRef({ values, rows, cols, range, profile: usesProfile ? profile! : null });
  latest.current = { values, rows, cols, range, profile: usesProfile ? profile! : null };

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { width, height } = sizeRef.current;
    if (width <= 0 || height <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { values: v, rows: r, cols: c, range: rg, profile: pf } = latest.current;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (pf) {
      const fit = fitProfileRect(width, height, pf.background.aspectRatio);
      const img = pf.background.imageData ? cachedImage(pf.background.imageData, draw) : null;
      if (img) ctx.drawImage(img, fit.offsetX, fit.offsetY, fit.drawWidth, fit.drawHeight);
      const dot = clamp(Math.min(fit.drawWidth, fit.drawHeight) * 0.028 * (pf.display?.dotSize ?? 1), 5, 22);
      for (const p of profilePoints(pf, v, v ? v.length : Infinity)) {
        ctx.globalAlpha = v ? 0.92 : 0.35;
        ctx.fillStyle = cssColorForValue(v ? p.value : rg.min, rg);
        ctx.beginPath();
        ctx.arc(fit.offsetX + p.xRatio * fit.drawWidth, fit.offsetY + p.yRatio * fit.drawHeight, dot, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      return;
    }
    const cell = Math.min(width / c, height / r);
    const gap = Math.max(1, Math.min(3, cell * 0.08));
    const offX = (width - cell * c) / 2;
    const offY = (height - cell * r) / 2;
    const radius = Math.min(4, cell * 0.18);
    for (let row = 0; row < r; row++) {
      for (let col = 0; col < c; col++) {
        const value = v ? (v[row * c + col] ?? 0) : rg.min;
        ctx.fillStyle = cssColorForValue(value, rg);
        ctx.globalAlpha = v ? 1 : 0.35;
        const x = offX + col * cell + gap / 2;
        const y = offY + row * cell + gap / 2;
        const s = cell - gap;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, s, s, radius);
        else ctx.rect(x, y, s, s);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  };

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const measure = () => {
      const width = wrap.clientWidth;
      const { rows: r, cols: c, profile: pf } = latest.current;
      let height = pf ? width / Math.max(0.01, pf.background.aspectRatio) : (width * r) / Math.max(1, c);
      if (maxHeight && height > maxHeight) height = maxHeight;
      sizeRef.current = { width, height };
      if (canvasRef.current) {
        canvasRef.current.style.width = `${width}px`;
        canvasRef.current.style.height = `${height}px`;
      }
      draw();
    };
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(wrap);
    return () => observer?.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, cols, maxHeight, usesProfile, profile?.background.aspectRatio]);

  useEffect(draw);

  return (
    <div ref={wrapRef} className="heatmap">
      <canvas ref={canvasRef} role="img" aria-label={label} />
    </div>
  );
}

/** The colour scale as a gradient bar with its range. */
export function ColourScale({ range, label }: { range: PressureRange; label: string }) {
  const stops = [0, 0.25, 0.5, 0.75, 1].map((f) => `${cssColorForValue(range.min + f * (range.max - range.min), range)} ${f * 100}%`);
  return (
    <div className="colour-scale" role="img" aria-label={`${label}: ${range.min}–${range.max}`}>
      <span className="mono">{range.min}</span>
      <span className="colour-scale-bar" style={{ background: `linear-gradient(90deg, ${stops.join(', ')})` }} />
      <span className="mono">{range.max}</span>
    </div>
  );
}
