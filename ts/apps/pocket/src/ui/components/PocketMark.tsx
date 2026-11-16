// The full NH Pocket icon for the About screen, drawn from the shared artwork
// (brandIconShapes, the same shapes scripts/build-icons.mjs renders), and the
// University of Aizu wordmark for its credits. Brand artwork keeps its own
// fixed colours, as the app icon does. With `playKey` the planet slides in
// once from its corner each time the key changes (the screen gaining focus);
// skipped when the system asks for reduced motion.

import { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, Animated, Easing } from 'react-native';
import Svg, { ClipPath, Defs, G, Path, Rect } from 'react-native-svg';
import { BRAND_ICON, UAIZU_LOGO, brandIconShapes, type BrandShape } from '@nhgw/ui-tokens';

const SHAPES = brandIconShapes('pocket');

function Shape({ s }: { s: BrandShape }) {
  return s.stroke ? (
    <Path d={s.d} fill="none" stroke={s.stroke} strokeWidth={s.strokeWidth} strokeLinecap="round" strokeLinejoin="round" opacity={s.opacity} />
  ) : (
    <Path d={s.d} fill={s.fill} opacity={s.opacity} />
  );
}

export function PocketMark({ size = 72, playKey }: { size?: number; playKey?: number }) {
  const { rise } = BRAND_ICON.pocket;
  const progress = useMemo(() => new Animated.Value(playKey === undefined ? 1 : 0), []); // eslint-disable-line react-hooks/exhaustive-deps
  // The planet is several paths: follow the animation in state and move their group.
  const [t, setT] = useState(playKey === undefined ? 1 : 0);

  useEffect(() => {
    const id = progress.addListener(({ value }) => setT(value));
    return () => progress.removeListener(id);
  }, [progress]);

  useEffect(() => {
    if (playKey === undefined) return undefined;
    let cancelled = false;
    let animation: Animated.CompositeAnimation | null = null;
    void AccessibilityInfo.isReduceMotionEnabled()
      .catch(() => false)
      .then((reduced) => {
        if (cancelled) return;
        if (reduced) {
          progress.setValue(1);
          return;
        }
        progress.setValue(0);
        animation = Animated.timing(progress, {
          toValue: 1,
          duration: BRAND_ICON.durationMs,
          easing: Easing.bezier(0.22, 1, 0.36, 1),
          useNativeDriver: false,
        });
        animation.start();
      });
    return () => {
      cancelled = true;
      animation?.stop();
    };
  }, [playKey, progress]);

  const dx = rise.dx * (1 - t);
  const dy = rise.dy * (1 - t);

  return (
    <Svg width={size} height={size} viewBox="0 0 100 100" accessibilityRole="image" accessibilityLabel="NH Pocket">
      <Defs>
        <ClipPath id="nhPocketFrame">
          <Rect x={0} y={0} width={100} height={100} rx={22} />
        </ClipPath>
      </Defs>
      <G clipPath="url(#nhPocketFrame)">
        {SHAPES.filter((s) => s.layer !== 'body').map((s, i) => <Shape key={`s${i}`} s={s} />)}
        <G transform={`translate(${dx} ${dy})`}>{SHAPES.filter((s) => s.layer === 'body').map((s, i) => <Shape key={`p${i}`} s={s} />)}</G>
      </G>
    </Svg>
  );
}

export function UAizuLogo({ width = 110, color }: { width?: number; color: string }) {
  const [, , w, h] = UAIZU_LOGO.viewBox.split(' ').map(Number);
  return (
    <Svg width={width} height={(width * h!) / w!} viewBox={UAIZU_LOGO.viewBox} accessibilityElementsHidden importantForAccessibility="no">
      <Path transform={`translate(0 ${UAIZU_LOGO.translateY})`} d={UAIZU_LOGO.d} fill={color} fillRule="evenodd" clipRule="evenodd" />
    </Svg>
  );
}
