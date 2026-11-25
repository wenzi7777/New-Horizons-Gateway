import type { MagVec } from "@nhgw/host";

// Before / after, as the three axis-plane projections: before the fit the
// samples sit on an ellipsoid away from the origin (offset, stretch), after
// it on a sphere of the fitted field around it -- the dashed circle.

const PLANES: { label: string; a: 0 | 1 | 2; b: 0 | 1 | 2 }[] = [
  { label: "X–Y", a: 0, b: 1 },
  { label: "X–Z", a: 0, b: 2 },
  { label: "Y–Z", a: 1, b: 2 },
];
const MAX_DRAWN = 700;

function thin(points: readonly MagVec[]): readonly MagVec[] {
  if (points.length <= MAX_DRAWN) return points;
  const step = points.length / MAX_DRAWN;
  const out: MagVec[] = [];
  for (let i = 0; i < MAX_DRAWN; i++) out.push(points[Math.floor(i * step)]!);
  return out;
}

export function CalibrationResultPlot({
  before,
  after,
  fieldUt,
  beforeLabel,
  afterLabel,
}: {
  before: readonly MagVec[];
  after: readonly MagVec[];
  fieldUt: number;
  beforeLabel: string;
  afterLabel: string;
}) {
  const b = thin(before);
  const a = thin(after);
  let extent = fieldUt * 1.15;
  for (const p of [...b, ...a]) extent = Math.max(extent, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  extent = Math.max(1, extent * 1.05);
  const size = 100;
  const scale = (size / 2 - 4) / extent;
  return (
    <div className="mag-result-plot">
      <div className="mag-result-planes">
        {PLANES.map((plane) => (
          <figure key={plane.label}>
            <svg viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`} aria-hidden="true">
              <line x1={-size / 2} y1={0} x2={size / 2} y2={0} className="mag-plot-axis" />
              <line x1={0} y1={-size / 2} x2={0} y2={size / 2} className="mag-plot-axis" />
              <circle cx={0} cy={0} r={fieldUt * scale} className="mag-plot-field" />
              {b.map((p, i) => <circle key={`b${i}`} cx={p[plane.a] * scale} cy={-p[plane.b] * scale} r={0.9} className="mag-plot-before" />)}
              {a.map((p, i) => <circle key={`a${i}`} cx={p[plane.a] * scale} cy={-p[plane.b] * scale} r={0.9} className="mag-plot-after" />)}
            </svg>
            <figcaption>{plane.label}</figcaption>
          </figure>
        ))}
      </div>
      <div className="mag-result-legend">
        <span><i className="mag-plot-before" /> {beforeLabel}</span>
        <span><i className="mag-plot-after" /> {afterLabel}</span>
      </div>
    </div>
  );
}
