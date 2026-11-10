// The full NH Studio icon, drawn inline so the About page can animate it:
// the planet rises once past the horizon when the page opens (skipped under
// reduced motion). Also the University of Aizu wordmark for the credits.
import { useId } from 'react';
import { BRAND_ICON, UAIZU_LOGO } from '@nhgw/ui-tokens';

export function AnimatedBrandMark({ size = 128, animate = true }: { size?: number; animate?: boolean }) {
  const clip = `nh-frame-${useId().replace(/:/g, '')}`;
  const c = BRAND_ICON.studio;
  const [x1, y1] = BRAND_ICON.horizon.from;
  const [x2, y2] = BRAND_ICON.horizon.to;
  const line = `M${x1},${y1} L${x2},${y2}`;
  return (
    <svg
      className={`brand-art${animate ? ' rise' : ''}`}
      viewBox="0 0 100 100"
      width={size}
      height={size}
      role="img"
      aria-label="NH Studio"
      style={{ ['--rise-dx' as string]: `${BRAND_ICON.rise.dx}px`, ['--rise-dy' as string]: `${BRAND_ICON.rise.dy}px`, ['--rise-ms' as string]: `${BRAND_ICON.durationMs}ms` }}
    >
      <defs>
        <clipPath id={clip}>
          <rect x="0" y="0" width="100" height="100" rx="22" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <rect x="-200" y="-200" width="500" height="500" fill={c.sky} />
        <circle className="brand-planet" cx={BRAND_ICON.planet.cx} cy={BRAND_ICON.planet.cy} r={c.planetR} fill={c.planet} />
        <path d={`${line} L${x2},300 L${x1},300 Z`} fill={c.ground} />
        <path d={`${line} L${x2},${y2 + c.bandWidth} L${x1},${y1 + c.bandWidth} Z`} fill={c.band} />
        <path d={line} fill="none" stroke={c.line} strokeWidth={c.lineWidth} strokeLinecap="round" />
      </g>
    </svg>
  );
}

export function UAizuLogo({ className, title }: { className?: string; title?: string }) {
  return (
    <svg className={className} viewBox={UAIZU_LOGO.viewBox} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true} fill="currentColor" fillRule="evenodd" clipRule="evenodd">
      <path transform={`translate(0 ${UAIZU_LOGO.translateY})`} d={UAIZU_LOGO.d} />
    </svg>
  );
}
