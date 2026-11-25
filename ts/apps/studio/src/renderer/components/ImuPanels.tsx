// The Live card's IMU row, as the Desktop Visualization card draws it
// (New-Horizons-Desktop components/ImuPanels.tsx): Acc as a spirit level,
// Gyro as three centred bars, the magnetometer as a heading dial, each with
// the last ten seconds of x / y / z as trend lines and the numbers underneath.

import {
  gyroScale,
  headingFromMag,
  IMU_AXIS_COLORS,
  niceScale,
  tiltFromAcc,
  trendPolyline,
  vectorNorm,
  type ImuHistory,
  type ImuKey,
  type Vec3,
} from '@nhgw/host';

export type ImuPanelLabels = {
  acc: string;
  gyro: string;
  mag: string;
  noMag: string;
  heading: string;
  tilt: string;
  magnitude: string;
};

const AXES = ["X", "Y", "Z"] as const;
const TREND_W = 200;
const TREND_H = 56;

function trendScale(history: ImuHistory, key: ImuKey, now: number): number {
  const max = history.symmetricMax(key, now);
  if (key === "gyro") return gyroScale(max);
  return niceScale(max, key === "acc" ? 1 : 50);
}

function Trend({ history, k, now, label }: { history: ImuHistory; k: ImuKey; now: number; label: string }) {
  const points = history.series(k, now);
  const scale = trendScale(history, k, now);
  return (
    <div className="imu-trend">
      <svg viewBox={`0 0 ${TREND_W} ${TREND_H}`} preserveAspectRatio="none" role="img" aria-label={label}>
        <line className="imu-zero" x1={0} y1={TREND_H / 2} x2={TREND_W} y2={TREND_H / 2} vectorEffect="non-scaling-stroke" />
        {[0, 1, 2].map((axis) => (
          <polyline
            key={axis}
            points={trendPolyline(points, axis as 0 | 1 | 2, now, history.windowMs, scale, TREND_W, TREND_H)}
            fill="none"
            stroke={IMU_AXIS_COLORS[axis]}
            strokeWidth={1.5}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <span className="imu-trend-scale">±{scale}</span>
    </div>
  );
}

function AxisValues({ v, digits, unit }: { v: Vec3 | null; digits: number; unit: string }) {
  return (
    <span className="imu-axes">
      {AXES.map((name, i) => (
        <span key={name} style={{ color: IMU_AXIS_COLORS[i] }}>
          {name} {v ? (v[i] ?? 0).toFixed(digits) : "--"}
        </span>
      ))}
      <span className="imu-unit">{unit}</span>
    </span>
  );
}

function LevelGauge({ acc }: { acc: Vec3 | null }) {
  const tilt = acc ? tiltFromAcc(acc) : null;
  const r = 30;
  return (
    <svg className={`imu-gauge${tilt ? "" : " is-empty"}`} viewBox="0 0 72 72" aria-hidden="true">
      <circle className="imu-dial" cx={36} cy={36} r={r} />
      <circle className="imu-ring" cx={36} cy={36} r={r / 3} />
      <line className="imu-cross" x1={36 - r} y1={36} x2={36 + r} y2={36} />
      <line className="imu-cross" x1={36} y1={36 - r} x2={36} y2={36 + r} />
      {tilt ? <circle className="imu-bubble" cx={36 + tilt.bubbleX * (r - 7)} cy={36 + tilt.bubbleY * (r - 7)} r={7} /> : null}
    </svg>
  );
}

function GyroBars({ gyro, scale }: { gyro: Vec3 | null; scale: number }) {
  const left = 14;
  const right = 86;
  const mid = (left + right) / 2;
  const half = (right - left) / 2;
  return (
    <svg className={`imu-gauge is-wide${gyro ? "" : " is-empty"}`} viewBox="0 0 88 72" aria-hidden="true">
      {AXES.map((name, i) => {
        const y = 10 + i * 22;
        const value = gyro ? Math.max(-1, Math.min(1, (gyro[i] ?? 0) / scale)) : 0;
        const x = value >= 0 ? mid : mid + value * half;
        return (
          <g key={name}>
            <text className="imu-bar-label" x={0} y={y + 9} fill={IMU_AXIS_COLORS[i]}>
              {name}
            </text>
            <rect className="imu-track" x={left} y={y} width={right - left} height={12} rx={3} />
            <rect x={x} y={y} width={Math.abs(value) * half} height={12} rx={3} fill={IMU_AXIS_COLORS[i]} />
          </g>
        );
      })}
      <line className="imu-cross" x1={mid} y1={6} x2={mid} y2={66} />
    </svg>
  );
}

function HeadingDial({ heading }: { heading: number | null }) {
  const r = 30;
  return (
    <svg className={`imu-gauge${heading === null ? " is-empty" : ""}`} viewBox="0 0 72 72" aria-hidden="true">
      <circle className="imu-dial" cx={36} cy={36} r={r} />
      {[0, 90, 180, 270].map((deg, i) => {
        const a = (deg * Math.PI) / 180;
        return (
          <text key={deg} className={`imu-cardinal${i === 0 ? " is-north" : ""}`} x={36 + Math.sin(a) * (r - 8)} y={36 - Math.cos(a) * (r - 8) + 3.5} textAnchor="middle">
            {"NESW"[i]}
          </text>
        );
      })}
      {heading !== null ? (
        <g transform={`rotate(${heading} 36 36)`}>
          <polygon className="imu-needle" points={`36,${36 - r + 12} 40,40 36,37 32,40`} />
        </g>
      ) : null}
      <circle className="imu-hub" cx={36} cy={36} r={2.5} />
    </svg>
  );
}

/** The three panels for one device. Re-render them on every frame (`now` moves the trend lines). */
export function ImuPanels({ history, now, labels }: { history: ImuHistory; now: number; labels: ImuPanelLabels }) {
  const acc = history.latest("acc");
  const gyro = history.latest("gyro");
  const mag = history.latest("mag");
  const tilt = acc ? tiltFromAcc(acc) : null;
  const heading = mag ? headingFromMag(mag, acc) : null;
  const gyroFull = gyroScale(history.symmetricMax("gyro", now));
  return (
    <div className="imu-panels">
      <section className="imu-panel" aria-label={labels.acc}>
        <header>{labels.acc}</header>
        <div className="imu-panel-body">
          <LevelGauge acc={acc} />
          <Trend history={history} k="acc" now={now} label={labels.acc} />
        </div>
        <AxisValues v={acc} digits={2} unit="g" />
        <span className="imu-extra">
          {labels.magnitude} {acc ? vectorNorm(acc).toFixed(2) : "--"} g · {labels.tilt}{" "}
          {tilt ? `${tilt.rollDeg.toFixed(0)}° / ${tilt.pitchDeg.toFixed(0)}°` : "--"}
        </span>
      </section>
      <section className="imu-panel" aria-label={labels.gyro}>
        <header>{labels.gyro}</header>
        <div className="imu-panel-body">
          <GyroBars gyro={gyro} scale={gyroFull} />
          <Trend history={history} k="gyro" now={now} label={labels.gyro} />
        </div>
        <AxisValues v={gyro} digits={1} unit="°/s" />
      </section>
      <section className={`imu-panel${history.has("mag") ? "" : " is-missing"}`} aria-label={labels.mag}>
        <header>{labels.mag}</header>
        {history.has("mag") ? (
          <>
            <div className="imu-panel-body">
              <HeadingDial heading={heading} />
              <Trend history={history} k="mag" now={now} label={labels.mag} />
            </div>
            <AxisValues v={mag} digits={1} unit="µT" />
            <span className="imu-extra">
              {labels.magnitude} {mag ? vectorNorm(mag).toFixed(1) : "--"} µT · {labels.heading} {heading !== null ? `${heading.toFixed(0)}°` : "--"}
            </span>
          </>
        ) : (
          <p className="imu-missing">{labels.noMag}</p>
        )}
      </section>
    </div>
  );
}
