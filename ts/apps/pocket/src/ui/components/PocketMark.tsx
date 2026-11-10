// The NH Pocket icon (brand/svg/nh-pocket-rounded.svg) for the About screen.
// Brand artwork keeps its own fixed colours, as the app icon does.

import Svg, { ClipPath, Defs, G, Path, Rect, Circle } from 'react-native-svg';

export function PocketMark({ size = 72 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100" accessibilityRole="image" accessibilityLabel="NH Pocket">
      <Defs>
        <ClipPath id="nhPocketFrame">
          <Rect x={0} y={0} width={100} height={100} rx={22} />
        </ClipPath>
      </Defs>
      <G clipPath="url(#nhPocketFrame)">
        <Rect x={-200} y={-200} width={500} height={500} fill="#1f6b54" />
        <Circle cx={58} cy={50} r={16} fill="#f2fbf6" />
        <Path d="M-200,129.95454545454544 L300,-10.954545454545453 L300,300 L-200,300 Z" fill="#081a16" />
        <Path d="M-200,129.95454545454544 L300,-10.954545454545453 L300,3.0454545454545467 L-200,143.95454545454544 Z" fill="#0e2a23" />
        <Path d="M-200,129.95454545454544 L300,-10.954545454545453" fill="none" stroke="#5fd4a3" strokeWidth={5} strokeLinecap="round" />
      </G>
    </Svg>
  );
}
