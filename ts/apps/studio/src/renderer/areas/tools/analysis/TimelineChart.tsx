import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { useStudio } from "../../../state/studio";
import { bucketSeries, formatDuration, nearestIndex, niceTicks, timeTicks } from "../lib/recordingAnalysis";

export type ChartSeries = { key: string; label: string; color: string; value: (row: number) => number };
export type ChartMarker = { index: number; color: string; label: string };

type TimelineChartProps = {
  time: Float64Array;
  /** Rows [start, end) are on screen. */
  start: number;
  end: number;
  series: ChartSeries[];
  markers?: ChartMarker[];
  cursor: number | null;
  hover: number | null;
  height: number;
  /** Pin the y axis to zero (pressure); IMU axes float. */
  zeroBased?: boolean;
  formatValue: (value: number) => string;
  ariaLabel: string;
  onHover: (row: number | null) => void;
  onPick: (row: number) => void;
  onSelect: (start: number, end: number) => void;
  onReset: () => void;
};

const PAD = { left: 56, right: 12, top: 10, bottom: 24 };
const DRAG_MIN_PX = 5;

function cssVar(element: Element, name: string, fallback: string) {
  return getComputedStyle(element).getPropertyValue(name).trim() || fallback;
}

// Trace colours are picked for a white page; on the dark one, lift them a
// third of the way to white so dark greens and greys stay visible.
function traceColor(color: string, dark: boolean) {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!dark || !match) return color;
  const value = Number.parseInt(match[1]!, 16);
  const lift = (channel: number) => Math.round(channel + (255 - channel) * 0.35);
  return `rgb(${lift(value >> 16)}, ${lift((value >> 8) & 255)}, ${lift(value & 255)})`;
}

// One recording's trace against its own time (m:ss from the first row), drawn
// on a canvas as min/max per pixel column so a long recording keeps its
// spikes. The cursor, hover line and drag selection are DOM overlays: moving
// them never redraws the trace.
export type TimelineChartHandle = { canvas(): HTMLCanvasElement | null };

export const TimelineChart = forwardRef<TimelineChartHandle, TimelineChartProps>(function TimelineChart({
  time, start, end, series, markers = [], cursor, hover, height, zeroBased, formatValue, ariaLabel,
  onHover, onPick, onSelect, onReset,
}, ref) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const [mouseX, setMouseX] = useState<number | null>(null);
  const yRangeRef = useRef({ min: 0, max: 1 });
  useImperativeHandle(ref, () => ({ canvas: () => canvasRef.current }), []);
  // Colours come from CSS variables at draw time, so redraw on a theme switch.
  const dark = useStudio().theme.theme === "dark";

  const origin = time.length ? time[0]! : 0;
  const last = Math.max(start, end - 1);
  const t0 = time.length ? time[Math.min(start, time.length - 1)]! : 0;
  const t1 = time.length ? Math.max(t0 + 1, time[Math.min(last, time.length - 1)]!) : 1;
  const plotWidth = Math.max(1, width - PAD.left - PAD.right);
  const plotHeight = Math.max(1, height - PAD.top - PAD.bottom);

  useLayoutEffect(() => {
    const element = wrapRef.current;
    if (!element) return undefined;
    const update = () => setWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const lineColor = cssVar(canvas, "--line", "rgba(0,0,0,0.08)");
    const mutedColor = cssVar(canvas, "--text-muted", "#86868b");
    const columns = Math.max(1, Math.floor(plotWidth));
    const traces = series.map((item) => ({ item, buckets: bucketSeries(time, item.value, start, end, t0, t1, columns) }));

    let min = Infinity;
    let max = -Infinity;
    for (const { buckets } of traces) {
      for (const bucket of buckets) {
        if (!bucket) continue;
        if (bucket.min < min) min = bucket.min;
        if (bucket.max > max) max = bucket.max;
      }
    }
    if (!Number.isFinite(min)) {
      min = 0;
      max = 1;
    }
    if (zeroBased) min = Math.min(0, min);
    if (max - min < 1e-9) max = min + 1;
    const pad = (max - min) * 0.06;
    max += pad;
    if (!zeroBased || min < 0) min -= pad;
    yRangeRef.current = { min, max };
    const y = (value: number) => PAD.top + plotHeight - ((value - min) / (max - min)) * plotHeight;
    const x = (ms: number) => PAD.left + ((ms - t0) / (t1 - t0)) * plotWidth;

    context.font = "11px -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif";
    context.lineWidth = 1;
    context.strokeStyle = lineColor;
    context.fillStyle = mutedColor;
    context.textAlign = "right";
    context.textBaseline = "middle";
    for (const tick of niceTicks(min, max, Math.max(2, Math.floor(plotHeight / 36)))) {
      const ty = Math.round(y(tick)) + 0.5;
      context.beginPath();
      context.moveTo(PAD.left, ty);
      context.lineTo(PAD.left + plotWidth, ty);
      context.stroke();
      context.fillText(formatValue(tick), PAD.left - 6, ty);
    }
    context.textAlign = "center";
    context.textBaseline = "top";
    for (const tick of timeTicks(t0 - origin, t1 - origin, Math.max(2, Math.floor(plotWidth / 90)))) {
      const tx = Math.round(x(origin + tick)) + 0.5;
      context.beginPath();
      context.moveTo(tx, PAD.top);
      context.lineTo(tx, PAD.top + plotHeight);
      context.stroke();
      context.fillText(formatDuration(tick, (t1 - t0) < 10000), tx, PAD.top + plotHeight + 6);
    }

    for (const marker of markers) {
      if (marker.index < start || marker.index >= end) continue;
      const mx = Math.round(x(time[marker.index]!)) + 0.5;
      context.strokeStyle = traceColor(marker.color, dark);
      context.globalAlpha = 0.55;
      context.beginPath();
      context.moveTo(mx, PAD.top);
      context.lineTo(mx, PAD.top + plotHeight);
      context.stroke();
      context.globalAlpha = 1;
      context.fillStyle = traceColor(marker.color, dark);
      context.beginPath();
      context.moveTo(mx - 3.5, PAD.top);
      context.lineTo(mx + 3.5, PAD.top);
      context.lineTo(mx, PAD.top + 5);
      context.fill();
    }

    context.save();
    context.beginPath();
    context.rect(PAD.left, PAD.top, plotWidth, plotHeight);
    context.clip();
    context.lineWidth = 1.4;
    context.lineJoin = "round";
    for (const { item, buckets } of traces) {
      context.strokeStyle = traceColor(item.color, dark);
      context.beginPath();
      let started = false;
      buckets.forEach((bucket, column) => {
        if (!bucket) return;
        const bx = PAD.left + column + 0.5;
        if (started) context.lineTo(bx, y(bucket.first));
        else {
          context.moveTo(bx, y(bucket.first));
          started = true;
        }
        if (bucket.min !== bucket.max) {
          context.lineTo(bx, y(bucket.min));
          context.lineTo(bx, y(bucket.max));
        }
        context.lineTo(bx, y(bucket.last));
      });
      context.stroke();
    }
    context.restore();
  }, [time, start, end, series, markers, width, height, zeroBased, formatValue, t0, t1, origin, plotWidth, plotHeight, dark]);

  const toX = (row: number) => PAD.left + ((time[row]! - t0) / (t1 - t0)) * plotWidth;
  const rowAt = (clientX: number) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const px = Math.max(PAD.left, Math.min(PAD.left + plotWidth, clientX - rect.left));
    const ms = t0 + ((px - PAD.left) / plotWidth) * (t1 - t0);
    const row = nearestIndex(time, ms, time.length);
    return Math.max(start, Math.min(last, row));
  };
  const localX = (clientX: number) => clientX - (wrapRef.current?.getBoundingClientRect().left ?? 0);

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const px = localX(event.clientX);
    setDrag({ from: px, to: px });
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const px = localX(event.clientX);
    setMouseX(px);
    onHover(rowAt(event.clientX));
    if (drag) setDrag({ ...drag, to: px });
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!drag) return;
    const rect = wrapRef.current?.getBoundingClientRect();
    const from = drag.from;
    const to = localX(event.clientX);
    setDrag(null);
    if (!rect) return;
    if (Math.abs(to - from) < DRAG_MIN_PX) {
      const row = rowAt(event.clientX);
      if (row !== null) onPick(row);
      return;
    }
    const a = rowAt(rect.left + Math.min(from, to));
    const b = rowAt(rect.left + Math.max(from, to));
    if (a !== null && b !== null && b > a) onSelect(a, b + 1);
  }

  const hoverRow = hover !== null && hover >= start && hover < end ? hover : null;
  const nearMarkers = mouseX === null
    ? []
    : markers.filter((marker) => marker.index >= start && marker.index < end && Math.abs(toX(marker.index) - mouseX) <= 4);
  const tooltipLeft = hoverRow !== null ? toX(hoverRow) : 0;
  const tooltipOnLeft = tooltipLeft > width - 200;

  return (
    <div
      ref={wrapRef}
      className="analysis-chart"
      style={{ height }}
      role="img"
      aria-label={ariaLabel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={() => {
        setMouseX(null);
        onHover(null);
      }}
      onDoubleClick={onReset}
      tabIndex={0}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        const at = cursor ?? start;
        const step = event.shiftKey ? Math.max(1, Math.round((end - start) / 20)) : 1;
        if (event.key === "ArrowRight") onPick(Math.min(last, at + step));
        else if (event.key === "ArrowLeft") onPick(Math.max(start, at - step));
        else if (event.key === "Escape") onReset();
        else return;
        event.preventDefault();
      }}
    >
      <canvas ref={canvasRef} style={{ width: "100%", height }} />
      {cursor !== null && cursor >= start && cursor < end ? (
        <div className="analysis-chart-cursor" style={{ left: toX(cursor), top: PAD.top, height: plotHeight }} />
      ) : null}
      {hoverRow !== null ? (
        <div className="analysis-chart-hover" style={{ left: toX(hoverRow), top: PAD.top, height: plotHeight }} />
      ) : null}
      {drag && Math.abs(drag.to - drag.from) >= DRAG_MIN_PX ? (
        <div
          className="analysis-chart-selection"
          style={{
            left: Math.max(PAD.left, Math.min(drag.from, drag.to)),
            width: Math.min(PAD.left + plotWidth, Math.max(drag.from, drag.to)) - Math.max(PAD.left, Math.min(drag.from, drag.to)),
            top: PAD.top,
            height: plotHeight,
          }}
        />
      ) : null}
      {hoverRow !== null && !drag ? (
        <div
          className="analysis-chart-tooltip"
          style={tooltipOnLeft ? { right: width - tooltipLeft + 10, top: PAD.top } : { left: tooltipLeft + 10, top: PAD.top }}
        >
          <strong>{formatDuration(time[hoverRow]! - origin)}</strong>
          {series.map((item) => (
            <span key={item.key}>
              <i style={{ background: item.color }} />
              {item.label}
              <b>{formatValue(item.value(hoverRow))}</b>
            </span>
          ))}
          {nearMarkers.map((marker, index) => (
            <span key={`m${index}`} className="analysis-chart-tooltip-event">
              <i style={{ background: marker.color }} />
              {marker.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
});
