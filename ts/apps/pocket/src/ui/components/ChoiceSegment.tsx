// The "Illustrated" interface's big choice buttons on a phone: one card per
// option, the chosen one outlined in the accent colour with a check (Studio's
// components/callout/ChoiceSegment.tsx). Same props and behaviour as
// SegmentedControl, which the classic interface still shows.
import { Check } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import { useSettings } from '../store';
import { useTheme } from '../theme';
import { SegmentedControl } from './primitives';

export function ChoiceSegment<T extends string | number>(props: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const { uiStyle } = useSettings();
  const theme = useTheme();
  const { colors } = theme;
  if (uiStyle !== 'modern') return <SegmentedControl<T> {...props} />;
  const { options, value, onChange, disabled, accessibilityLabel } = props;
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel} style={{ flexDirection: 'row', gap: 8, opacity: disabled ? 0.5 : 1 }}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={String(option.value)}
            onPress={() => !selected && onChange(option.value)}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled: !!disabled }}
            accessibilityLabel={option.label}
            style={({ pressed }) => ({
              flex: 1,
              minHeight: 50,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingHorizontal: 10,
              paddingVertical: 8,
              borderRadius: 12,
              borderWidth: selected ? 2 : 1,
              borderColor: selected ? colors.accent : colors.lineStrong,
              backgroundColor: selected ? colors.accentSoft : pressed ? colors.panelSoft : colors.panelSolid,
            })}
          >
            <View
              style={{
                width: 20,
                height: 20,
                borderRadius: 10,
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: selected ? 0 : 1.5,
                borderColor: colors.lineStrong,
                backgroundColor: selected ? colors.accent : 'transparent',
              }}
            >
              {selected ? <Check size={13} strokeWidth={3} color="#fff" /> : null}
            </View>
            <Text numberOfLines={2} style={{ flex: 1, fontSize: 14, fontWeight: selected ? '700' : '500', color: colors.text }}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
