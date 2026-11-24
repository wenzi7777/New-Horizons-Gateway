// The battery drawn the Desktop's way (BatteryStatusIndicator, Studio's
// BatteryGlyph): outline, fill to the charge and, while charging, a solid bolt
// inside it with a gap cut around it so it stands clear on any background.
import { useId } from 'react';
import Svg, { Defs, G, Mask, Path, Rect } from 'react-native-svg';

const BOLT = 'M14.2 2.6 7.4 12.3h4.5l-1.6 7.1 6.9-10h-4.6Z';

export function BatteryGlyph({ percent, charging, color, width = 24 }: { percent: number | null; charging: boolean; color: string; width?: number }) {
  const maskId = `bolt${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const fill = percent === null ? 0 : (16 * Math.max(0, Math.min(100, percent))) / 100;
  return (
    <Svg width={width} height={(width * 22) / 28} viewBox="0 0 28 22">
      {charging ? (
        <Defs>
          <Mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="28" height="22">
            <Rect x="0" y="0" width="28" height="22" fill="#fff" />
            <Path d={BOLT} fill="#000" stroke="#000" strokeWidth={3} strokeLinejoin="round" />
          </Mask>
        </Defs>
      ) : null}
      <G mask={charging ? `url(#${maskId})` : undefined}>
        <Rect x="2" y="3" width="20" height="16" rx="3" fill="none" stroke={color} strokeWidth={1.6} />
        <Rect x="23" y="8" width="3" height="6" rx="1" fill={color} />
        {fill > 0 ? <Rect x="4" y="5" width={fill} height="12" rx="1" fill={color} fillOpacity={charging ? 0.55 : 1} /> : null}
      </G>
      {charging ? <Path d={BOLT} fill={color} /> : null}
    </Svg>
  );
}
