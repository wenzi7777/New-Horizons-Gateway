// Small pieces of the device's Apps section (the Desktop's
// components/deviceApps/AppParts.tsx): the app glyph, an iOS-style switch,
// the load sparkline and the load badge.
import { Gauge, SlidersHorizontal, Workflow } from 'lucide-react';

import type { AppLoadLevel } from '../../lib/deviceApps';
import { useAppsT } from '../../strings';

/** Readouts and panels: drawn by the Desktop, never run on the device. */
export function isViewKind(kind: string): boolean {
  return kind === 'readout' || kind === 'panel';
}

/** A rounded tile standing in for an app icon; the kind decides the glyph. */
export function AppGlyph({ kind, colour, size = 18 }: { kind: string; colour?: number; size?: number }) {
  const viewed = isViewKind(kind);
  return (
    <span className={`dapps-glyph${viewed ? ' view' : ''}${colour !== undefined ? ` dapps-colour-${colour}` : ''}`} aria-hidden="true">
      {kind === 'panel' ? <SlidersHorizontal size={size} strokeWidth={1.75} /> : viewed ? <Gauge size={size} strokeWidth={1.75} /> : <Workflow size={size} strokeWidth={1.75} />}
    </span>
  );
}

/** An iOS-style switch. `pending` dims it while the device catches up. */
export function AppSwitch({ checked, disabled, pending, label, onChange }: { checked: boolean; disabled?: boolean; pending?: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      className={`dapps-switch${checked ? ' on' : ''}${pending ? ' pending' : ''}`}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onChange(!checked);
      }}
    >
      <i aria-hidden="true" />
    </button>
  );
}

/** The last minute of an app's load (0..100), one point per poll. */
export function LoadSparkline({ points, level }: { points: readonly number[]; level: AppLoadLevel }) {
  const width = 120;
  const height = 28;
  const span = 60;
  if (points.length < 2) return <svg className={`dapps-spark ${level}`} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" />;
  const shown = points.slice(-span);
  const step = width / (span - 1);
  const offset = (span - shown.length) * step;
  const y = (value: number) => height - 1 - (Math.max(0, Math.min(100, value)) / 100) * (height - 2);
  const line = shown.map((value, index) => `${(offset + index * step).toFixed(1)},${y(value).toFixed(1)}`);
  const area = `${offset.toFixed(1)},${height} ${line.join(' ')} ${width},${height}`;
  return (
    <svg className={`dapps-spark ${level}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon points={area} className="dapps-spark-area" />
      <polyline points={line.join(' ')} className="dapps-spark-line" />
    </svg>
  );
}

/** "Load 42" with the level's colour. */
export function LoadBadge({ load, level }: { load: number; level: AppLoadLevel }) {
  const t = useAppsT();
  return (
    <span className={`dapps-load ${level}`} title={t(`appsLevel_${level}`)}>
      <strong>{Math.round(load)}</strong>
      <small>{t(`appsLevel_${level}`)}</small>
    </span>
  );
}
