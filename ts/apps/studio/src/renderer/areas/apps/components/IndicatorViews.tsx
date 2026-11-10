// The device's outputs drawn as plain data, shared by the App Studio
// emulator (computed in the renderer) and a device's Apps page (mirroring
// what the device reports through app_view). Geometry: AppDisplay.h's
// kOledRows / kOledRowPx / kOledWidthPx, restated so the device page does not
// pull in the SDK.
import { useAppsT } from '../strings';

const OLED_ROWS = 4;
const OLED_ROW_PX = 8;
const OLED_WIDTH_PX = 128;
const GLYPH_PX = 6;

export type OledRowView = { kind: 'text' | 'bar'; label: string; text?: string; bar?: { x0: number; width: number; fillPx: number } };

export function LedDot({ rgb }: { rgb: readonly [number, number, number] | readonly number[] }) {
  const t = useAppsT();
  const lit = rgb.some((channel) => channel > 0);
  return (
    <span className="apps-led" title={t('sdkEmuLed')}>
      <i style={lit ? { background: `rgb(${rgb.join(',')})` } : undefined} className={lit ? 'lit' : undefined} aria-hidden="true" />
      LED
    </span>
  );
}

export function OledPanel({ rows }: { rows: readonly (OledRowView | null)[] }) {
  const t = useAppsT();
  return (
    <div className="apps-oled">
      <svg viewBox={`0 0 ${OLED_WIDTH_PX} ${OLED_ROWS * OLED_ROW_PX}`} role="img" aria-label={t('sdkEmuOled')}>
        {rows.slice(0, OLED_ROWS).map((row, index) => {
          if (!row) return null;
          const y = index * OLED_ROW_PX;
          const text = row.kind === 'text' ? row.text ?? '' : row.label;
          return (
            <g key={index}>
              {text ? (
                <text x={0} y={y + 7} fontSize={8} fill="currentColor" textLength={text.length * GLYPH_PX} lengthAdjust="spacingAndGlyphs" style={{ whiteSpace: 'pre' }}>
                  {text}
                </text>
              ) : null}
              {row.kind === 'bar' && row.bar ? (
                <>
                  <rect x={row.bar.x0 + 0.5} y={y + 0.5} width={Math.max(0, row.bar.width - 1)} height={OLED_ROW_PX - 2} fill="none" stroke="currentColor" strokeWidth={1} />
                  {row.bar.fillPx > 0 ? <rect x={row.bar.x0 + 1} y={y + 1} width={row.bar.fillPx} height={OLED_ROW_PX - 3} fill="currentColor" /> : null}
                </>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function StripPixels({ pixels }: { pixels: readonly (readonly number[])[] }) {
  const t = useAppsT();
  return (
    <div className="apps-strip" role="img" aria-label={t('sdkEmuExtLed')}>
      {pixels.map((rgb, index) => {
        const lit = rgb.some((channel) => channel > 0);
        return (
          <span key={index} className={`apps-strip-pixel${lit ? ' lit' : ''}`} title={`${index}`} style={lit ? { background: `rgb(${rgb.join(',')})` } : undefined}>
            <small>{index}</small>
          </span>
        );
      })}
    </div>
  );
}
