// The full NH Studio icon, drawn inline from the shared artwork
// (brandIconShapes, the same shapes scripts/build-icons.mjs renders) so the
// About page can animate it: the planet rises once past the horizon when the
// page opens (skipped under reduced motion). Also the University of Aizu
// wordmark for the credits.
import { useId } from 'react';
import { BRAND_ICON, UAIZU_LOGO, brandIconShapes, type BrandShape } from '@nhgw/ui-tokens';

const SHAPES = brandIconShapes('studio');

function Shape({ s }: { s: BrandShape }) {
  return s.stroke ? (
    <path d={s.d} fill="none" stroke={s.stroke} strokeWidth={s.strokeWidth} strokeLinecap="round" strokeLinejoin="round" opacity={s.opacity} />
  ) : (
    <path d={s.d} fill={s.fill} opacity={s.opacity} />
  );
}

export function AnimatedBrandMark({ size = 128, animate = true }: { size?: number; animate?: boolean }) {
  const clip = `nh-frame-${useId().replace(/:/g, '')}`;
  const { rise } = BRAND_ICON.studio;
  const firstBody = SHAPES.findIndex((s) => s.layer === 'body');
  const before = SHAPES.slice(0, firstBody);
  const body = SHAPES.filter((s) => s.layer === 'body');
  const after = SHAPES.slice(firstBody).filter((s) => s.layer !== 'body');
  return (
    <svg
      className={`brand-art${animate ? ' rise' : ''}`}
      viewBox="0 0 100 100"
      width={size}
      height={size}
      role="img"
      aria-label="NH Studio"
      style={{ ['--rise-dx' as string]: `${rise.dx}px`, ['--rise-dy' as string]: `${rise.dy}px`, ['--rise-ms' as string]: `${BRAND_ICON.durationMs}ms` }}
    >
      <defs>
        <clipPath id={clip}>
          <rect x="0" y="0" width="100" height="100" rx="22" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        {before.map((s, i) => <Shape key={`b${i}`} s={s} />)}
        <g className="brand-planet">{body.map((s, i) => <Shape key={`p${i}`} s={s} />)}</g>
        {after.map((s, i) => <Shape key={`a${i}`} s={s} />)}
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
