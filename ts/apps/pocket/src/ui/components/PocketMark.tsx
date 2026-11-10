// The full NH Pocket icon (brand/svg/nh-pocket.svg) for the About screen,
// and the University of Aizu wordmark for its credits. Brand artwork keeps
// its own fixed colours, as the app icon does. With `playKey` the planet
// rises once past the horizon each time the key changes (the screen gaining
// focus); skipped when the system asks for reduced motion.

import { useEffect, useMemo } from 'react';
import { AccessibilityInfo, Animated, Easing } from 'react-native';
import Svg, { Circle, ClipPath, Defs, G, Path, Rect } from 'react-native-svg';
import { BRAND_ICON, UAIZU_LOGO } from '@nhgw/ui-tokens';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export function PocketMark({ size = 72, playKey }: { size?: number; playKey?: number }) {
  const c = BRAND_ICON.pocket;
  const [x1, y1] = BRAND_ICON.horizon.from;
  const [x2, y2] = BRAND_ICON.horizon.to;
  const line = `M${x1},${y1} L${x2},${y2}`;
  const progress = useMemo(() => new Animated.Value(playKey === undefined ? 1 : 0), []); // eslint-disable-line react-hooks/exhaustive-deps

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

  const cx = progress.interpolate({ inputRange: [0, 1], outputRange: [BRAND_ICON.planet.cx + BRAND_ICON.rise.dx, BRAND_ICON.planet.cx] });
  const cy = progress.interpolate({ inputRange: [0, 1], outputRange: [BRAND_ICON.planet.cy + BRAND_ICON.rise.dy, BRAND_ICON.planet.cy] });

  return (
    <Svg width={size} height={size} viewBox="0 0 100 100" accessibilityRole="image" accessibilityLabel="NH Pocket">
      <Defs>
        <ClipPath id="nhPocketFrame">
          <Rect x={0} y={0} width={100} height={100} rx={22} />
        </ClipPath>
      </Defs>
      <G clipPath="url(#nhPocketFrame)">
        <Rect x={-200} y={-200} width={500} height={500} fill={c.sky} />
        <AnimatedCircle cx={cx} cy={cy} r={c.planetR} fill={c.planet} />
        <Path d={`${line} L${x2},300 L${x1},300 Z`} fill={c.ground} />
        <Path d={`${line} L${x2},${y2 + c.bandWidth} L${x1},${y1 + c.bandWidth} Z`} fill={c.band} />
        <Path d={line} fill="none" stroke={c.line} strokeWidth={c.lineWidth} strokeLinecap="round" />
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
