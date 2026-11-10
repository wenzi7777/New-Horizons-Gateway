// A recording's timeline: summed pressure per bucket as a min..max band with
// the max as a line, event markers, and the time axis (0 .. duration).

import { useMemo } from 'react';

import type { RecordingTimeline } from '../../shared/contract';
import { formatDuration } from '../lib/format';

const W = 1000;
const H = 180;
const PAD_Y = 8;

export function timelinePaths(buckets: readonly { min: number; max: number }[], width = W, height = H): { band: string; top: string } {
  if (buckets.length === 0) return { band: '', top: '' };
  const lo = Math.min(...buckets.map((b) => b.min));
  const hi = Math.max(...buckets.map((b) => b.max));
  const span = Math.max(hi - lo, 1);
  const x = (i: number) => (buckets.length === 1 ? width / 2 : (i / (buckets.length - 1)) * width);
  const y = (v: number) => PAD_Y + (1 - (v - lo) / span) * (height - 2 * PAD_Y);
  const upper = buckets.map((b, i) => `${x(i).toFixed(1)},${y(b.max).toFixed(1)}`);
  const lower = buckets.map((b, i) => `${x(i).toFixed(1)},${y(b.min).toFixed(1)}`).reverse();
  return { band: `M${upper.join(' L')} L${lower.join(' L')} Z`, top: `M${upper.join(' L')}` };
}

export function TimelineChart({ timeline, label }: { timeline: RecordingTimeline; label: string }) {
  const { band, top } = useMemo(() => timelinePaths(timeline.buckets), [timeline.buckets]);
  const { durationMs, events } = timeline;
  return (
    <figure className="timeline">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} className="timeline-grid" />
        ))}
        {band ? <path d={band} className="timeline-band" /> : null}
        {top ? <path d={top} className="timeline-line" /> : null}
        {durationMs > 0
          ? events.map((ev, i) => {
              const ex = Math.max(1, Math.min(W - 1, (ev.atMs / durationMs) * W));
              return (
                <line key={i} x1={ex} x2={ex} y1={0} y2={H} className="timeline-event">
                  <title>{`${formatDuration(ev.atMs)} ${ev.label}`}</title>
                </line>
              );
            })
          : null}
      </svg>
      <figcaption className="timeline-axis">
        <span>0:00</span>
        <span>{formatDuration(durationMs)}</span>
      </figcaption>
    </figure>
  );
}
