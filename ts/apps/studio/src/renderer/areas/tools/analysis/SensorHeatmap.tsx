import { cssColorForValue } from "../../../lib/pressureColor";

type SensorHeatmapProps = {
  names: string[];
  values: Float32Array;
  columns: number;
  scaleMax: number;
  selected: number[];
  formatValue: (value: number) => string;
  onToggle: (sensor: number) => void;
};

// The sensors in CSV order, row by row from P1 (sensorLabel.ts), on the same
// colour scale as the Visualization page. A cell toggles that sensor's trace.
export function SensorHeatmap({ names, values, columns, scaleMax, selected, formatValue, onToggle }: SensorHeatmapProps) {
  const range = { min: 0, max: Math.max(1, scaleMax) };
  const compact = columns > 10;
  return (
    <div className="analysis-heatmap-wrap">
      <div
        className={`analysis-heatmap${compact ? " compact" : ""}`}
        style={{ gridTemplateColumns: `repeat(${Math.max(1, columns)}, minmax(0, 1fr))` }}
      >
        {names.map((name, sensor) => {
          const value = values[sensor] ?? 0;
          const order = selected.indexOf(sensor);
          return (
            <button
              key={name}
              type="button"
              className={`analysis-heatmap-cell${order >= 0 ? " selected" : ""}`}
              style={{ background: value > 0 ? cssColorForValue(value, range) : undefined }}
              title={`${name}: ${formatValue(value)}`}
              aria-label={`${name}: ${formatValue(value)}`}
              aria-pressed={order >= 0}
              onClick={() => onToggle(sensor)}
            >
              <span className="analysis-heatmap-name">{name}</span>
              {!compact ? <span className="analysis-heatmap-value">{formatValue(value)}</span> : null}
            </button>
          );
        })}
      </div>
      <div className="analysis-heatmap-legend" aria-hidden="true">
        <span>0</span>
        <i
          style={{
            background: `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((ratio) => cssColorForValue(ratio * range.max, range)).join(", ")})`,
          }}
        />
        <span>{formatValue(range.max)}</span>
      </div>
    </div>
  );
}
