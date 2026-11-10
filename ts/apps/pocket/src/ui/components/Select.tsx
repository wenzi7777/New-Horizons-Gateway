// A drawn Select in the Desktop's style (components/Select.tsx): a field
// with the chosen label and a chevron; it opens a bottom sheet listing the
// options with a checkmark on the chosen one. No platform picker. On web a
// hardware keyboard works (arrows / Home / End / Enter / Space / Escape).

import { Check, ChevronDown } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Animated, Modal, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useI18n } from '../i18n';
import { useTheme } from '../theme';
import { MAX_CONTENT_WIDTH, MIN_TOUCH } from './primitives';
import { initialIndex, selectedLabel, selectKey, type SelectOption } from './selectLogic';

export type { SelectOption } from './selectLogic';

export function Select<T extends string | number>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  /** Accessible name and sheet title. */
  label: string;
  options: readonly SelectOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const { colors } = theme;
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const slide = useRef(new Animated.Value(0)).current;
  const current = selectedLabel(options, value, t('selectChoose'));

  const close = () => setOpen(false);
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    setOpen(false);
    if (option.value !== value) onChange(option.value);
  };

  useEffect(() => {
    if (!open) return;
    setActive(initialIndex(options, value));
    slide.setValue(theme.reduceMotion ? 1 : 0);
    if (!theme.reduceMotion) Animated.timing(slide, { toValue: 1, duration: theme.motion.med || 220, easing: theme.easing, useNativeDriver: true }).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Hardware keyboard (web preview / tablets with keyboards on web).
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    if (!open || Platform.OS !== 'web') return;
    const doc = (globalThis as { document?: { addEventListener: (t: string, f: (e: KeyboardEvent) => void) => void; removeEventListener: (t: string, f: (e: KeyboardEvent) => void) => void } }).document;
    if (!doc) return;
    const onKey = (e: KeyboardEvent) => {
      const result = selectKey(options, activeRef.current, e.key);
      if (result.action === 'none' && result.index === activeRef.current) return;
      e.preventDefault();
      setActive(result.index);
      if (result.action === 'choose') choose(result.index);
      if (result.action === 'close') close();
    };
    doc.addEventListener('keydown', onKey);
    return () => doc.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, options]);

  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [320, 0] });

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        disabled={disabled}
        accessibilityRole="combobox"
        accessibilityLabel={label}
        accessibilityValue={{ text: current }}
        accessibilityState={{ expanded: open, disabled: !!disabled }}
        style={({ pressed }) => ({
          minHeight: MIN_TOUCH,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 12,
          borderRadius: theme.radius.sm,
          borderWidth: 1,
          borderColor: open ? colors.accent : colors.lineStrong,
          boxShadow: open ? `0 0 0 3px ${colors.accentSoft}` : undefined,
          backgroundColor: pressed ? colors.panelSoft : colors.panelSolid,
          opacity: disabled ? 0.5 : 1,
        })}
      >
        <Text numberOfLines={1} style={{ flex: 1, color: colors.text, fontSize: 16 }}>
          {current}
        </Text>
        <ChevronDown size={18} color={colors.textDim} />
      </Pressable>

      <Modal visible={open} transparent animationType="none" onRequestClose={close} statusBarTranslucent navigationBarTranslucent>
        <View style={{ flex: 1, justifyContent: 'flex-end', alignItems: 'center' }}>
          <Pressable accessibilityLabel={t('cancel')} onPress={close} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
            <View style={{ flex: 1, backgroundColor: colors.bg, opacity: 0.7 }} />
          </Pressable>
          <Animated.View
            style={{
              width: '100%',
              maxWidth: MAX_CONTENT_WIDTH,
              maxHeight: '70%',
              backgroundColor: colors.panelSolid,
              borderTopLeftRadius: theme.radius.lg,
              borderTopRightRadius: theme.radius.lg,
              boxShadow: theme.shadow.md,
              paddingBottom: insets.bottom + 8,
              transform: [{ translateY }],
            }}
          >
            <View style={{ alignItems: 'center', paddingTop: 8 }}>
              <View style={{ width: 36, height: 5, borderRadius: 3, backgroundColor: colors.lineStrong }} />
            </View>
            <Text accessibilityRole="header" style={{ color: colors.text, fontSize: 17, fontWeight: '600', paddingHorizontal: 20, paddingVertical: 12 }}>
              {label}
            </Text>
            <ScrollView accessibilityRole="list">
              {options.map((option, i) => {
                const selected = option.value === value;
                const highlighted = i === active;
                return (
                  <Pressable
                    key={String(option.value)}
                    onPress={() => choose(i)}
                    disabled={option.disabled}
                    accessibilityRole="menuitem"
                    accessibilityLabel={option.label}
                    accessibilityState={{ selected, disabled: !!option.disabled }}
                    style={({ pressed }) => ({
                      flexDirection: 'row',
                      alignItems: 'center',
                      minHeight: 50,
                      paddingHorizontal: 20,
                      gap: 12,
                      backgroundColor: pressed || highlighted ? colors.panelSoft : 'transparent',
                      opacity: option.disabled ? 0.45 : 1,
                    })}
                  >
                    <Text style={{ flex: 1, color: selected ? colors.accent : colors.text, fontSize: 16, fontWeight: selected ? '600' : '400' }}>
                      {option.label}
                    </Text>
                    {selected ? <Check size={20} color={colors.accent} /> : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </Animated.View>
        </View>
      </Modal>
    </>
  );
}
