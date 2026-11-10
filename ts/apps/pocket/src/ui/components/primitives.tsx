// Building blocks in the Desktop's style: cards (panel + radius-lg +
// shadow-sm), section headings, list rows, buttons (accent primary, danger
// destructive), segmented controls, switches, status dots, badges, notices,
// collapsible technical details. Colours, radii, shadows and motion come
// from the theme (ui-tokens) only. Touch targets are at least 44 pt.

import { ChevronDown, ChevronRight, type LucideIcon } from 'lucide-react-native';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Animated,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { cardStyle, useTheme } from '../theme';

export const MIN_TOUCH = 44;
/** Content column width on the tablet: phone layout, centred. */
export const MAX_CONTENT_WIDTH = 720;

// -- layout ---------------------------------------------------------------------

/** A scrolling screen body: safe-area aware, centred column on wide screens. */
export function Screen({
  children,
  title,
  topInset = true,
}: {
  children: ReactNode;
  title?: string;
  /** False under a navigation header (the header already clears the status bar). */
  topInset?: boolean;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: (topInset ? insets.top : 0) + 12,
          paddingBottom: 32,
          paddingLeft: Math.max(16, insets.left + 16),
          paddingRight: Math.max(16, insets.right + 16),
          alignItems: 'center',
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ width: '100%', maxWidth: MAX_CONTENT_WIDTH, gap: 16 }}>
          {title ? <LargeTitle>{title}</LargeTitle> : null}
          {children}
        </View>
      </ScrollView>
    </View>
  );
}

export function LargeTitle({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <Text accessibilityRole="header" style={{ color: colors.text, fontSize: 30, fontWeight: '700', letterSpacing: 0.2, marginTop: 4 }}>
      {children}
    </Text>
  );
}

export function Card({ children, style, padded = true }: { children: ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean }) {
  const theme = useTheme();
  return <View style={[cardStyle(theme), padded && { padding: 16, gap: 12 }, !padded && { overflow: 'hidden' }, style]}>{children}</View>;
}

/** A heading above a card, with an optional trailing element. */
export function SectionHeader({ title, trailing, caption }: { title: string; trailing?: ReactNode; caption?: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: 2, marginTop: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 24 }}>
        <Text accessibilityRole="header" style={{ color: colors.text, fontSize: 17, fontWeight: '600' }}>
          {title}
        </Text>
        {trailing}
      </View>
      {caption ? <Caption>{caption}</Caption> : null}
    </View>
  );
}

export function Divider({ inset = 16 }: { inset?: number }) {
  const { colors } = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: inset }} />;
}

// -- text -----------------------------------------------------------------------

export function Body({ children, style, dim, numberOfLines }: { children: ReactNode; style?: StyleProp<TextStyle>; dim?: boolean; numberOfLines?: number }) {
  const { colors } = useTheme();
  return (
    <Text numberOfLines={numberOfLines} style={[{ color: dim ? colors.textDim : colors.text, fontSize: 15, lineHeight: 21 }, style]}>
      {children}
    </Text>
  );
}

export function Caption({ children, style, numberOfLines }: { children: ReactNode; style?: StyleProp<TextStyle>; numberOfLines?: number }) {
  const { colors } = useTheme();
  return (
    <Text numberOfLines={numberOfLines} style={[{ color: colors.textDim, fontSize: 13, lineHeight: 18 }, style]}>
      {children}
    </Text>
  );
}

export function Mono({ children, style, selectable = true }: { children: ReactNode; style?: StyleProp<TextStyle>; selectable?: boolean }) {
  const { colors } = useTheme();
  return (
    <Text selectable={selectable} style={[{ color: colors.text, fontSize: 14, fontFamily: 'monospace', fontVariant: ['tabular-nums'] }, style]}>
      {children}
    </Text>
  );
}

// -- status -----------------------------------------------------------------------

export type Tone = 'success' | 'warning' | 'danger' | 'accent' | 'muted';

export function toneColor(colors: ReturnType<typeof useTheme>['colors'], tone: Tone): string {
  switch (tone) {
    case 'success':
      return colors.success;
    case 'warning':
      return colors.warning;
    case 'danger':
      return colors.danger;
    case 'accent':
      return colors.accent;
    case 'muted':
      return colors.textMuted;
  }
}

export function StatusDot({ tone, size = 10, pulse = false }: { tone: Tone; size?: number; pulse?: boolean }) {
  const theme = useTheme();
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!pulse || theme.reduceMotion) {
      opacity.setValue(1);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.35, duration: 700, easing: theme.easing, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 700, easing: theme.easing, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, theme.reduceMotion, theme.easing, opacity]);
  return (
    <Animated.View
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: toneColor(theme.colors, tone), opacity }}
    />
  );
}

/** A small pill label, e.g. REC or a sync state. */
export function Badge({ label, tone, icon: Icon, solid = false }: { label: string; tone: Tone; icon?: LucideIcon; solid?: boolean }) {
  const theme = useTheme();
  const color = toneColor(theme.colors, tone);
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: theme.radius.pill,
        backgroundColor: solid ? color : theme.colors.panelSoft,
      }}
    >
      {Icon ? <Icon size={12} color={solid ? theme.colors.onAccent : color} strokeWidth={2.4} /> : null}
      <Text style={{ fontSize: 12, fontWeight: '600', color: solid ? theme.colors.onAccent : color }}>{label}</Text>
    </View>
  );
}

/** A coloured notice card: warning (e.g. Wi-Fi isolation) or neutral info. */
export function Notice({ tone = 'warning', icon: Icon, title, children }: { tone?: Tone; icon?: LucideIcon; title?: string; children?: ReactNode }) {
  const theme = useTheme();
  const color = toneColor(theme.colors, tone);
  return (
    <View
      accessibilityRole="alert"
      style={[
        cardStyle(theme),
        { flexDirection: 'row', gap: 12, padding: 14, borderLeftWidth: 4, borderLeftColor: color, alignItems: 'flex-start' },
      ]}
    >
      {Icon ? <Icon size={20} color={color} style={{ marginTop: 1 }} /> : null}
      <View style={{ flex: 1, gap: 4 }}>
        {title ? <Text style={{ color: theme.colors.text, fontSize: 15, fontWeight: '600' }}>{title}</Text> : null}
        {typeof children === 'string' ? <Body dim>{children}</Body> : children}
      </View>
    </View>
  );
}

// -- rows -------------------------------------------------------------------------

/** A list row inside a card: leading element, title/subtitle, trailing element, optional chevron. */
export function ListRow({
  title,
  subtitle,
  leading,
  trailing,
  onPress,
  chevron = !!onPress,
  disabled,
  destructive,
  accessibilityLabel,
}: {
  title: string;
  subtitle?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  chevron?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  accessibilityLabel?: string;
}) {
  const { colors } = useTheme();
  const content = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 16, paddingVertical: 10 }}>
      {leading}
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: destructive ? colors.danger : colors.text, fontSize: 16, fontWeight: '500' }}>
          {title}
        </Text>
        {typeof subtitle === 'string' ? <Caption numberOfLines={2}>{subtitle}</Caption> : subtitle}
      </View>
      {trailing}
      {chevron ? <ChevronRight size={18} color={colors.textMuted} /> : null}
    </View>
  );
  if (!onPress) return content;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => ({ opacity: disabled ? 0.45 : pressed ? 0.6 : 1, backgroundColor: pressed ? colors.panelSoft : 'transparent' })}
    >
      {content}
    </Pressable>
  );
}

/** Label/value pair for detail facts. */
export function FactRow({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 44, paddingHorizontal: 16 }}>
      <Text style={{ color: colors.textDim, fontSize: 15 }}>{label}</Text>
      {typeof value === 'string' || typeof value === 'number' ? (
        <Text
          selectable
          numberOfLines={1}
          style={{ color: colors.text, fontSize: 15, flexShrink: 1, textAlign: 'right', fontFamily: mono ? 'monospace' : undefined, fontVariant: ['tabular-nums'] }}
        >
          {value}
        </Text>
      ) : (
        value
      )}
    </View>
  );
}

export function SwitchRow({
  title,
  subtitle,
  value,
  onValueChange,
  disabled,
}: {
  title: string;
  subtitle?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 16, paddingVertical: 10 }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: '500' }}>{title}</Text>
        {subtitle ? <Caption>{subtitle}</Caption> : null}
      </View>
      <Toggle label={title} value={value} onValueChange={onValueChange} disabled={disabled} />
    </View>
  );
}

/** A drawn on/off toggle (no platform Switch): accent track, sliding thumb; no slide under reduced motion. */
export function Toggle({
  label,
  value,
  onValueChange,
  disabled,
}: {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const { colors } = theme;
  const progress = useRef(new Animated.Value(value ? 1 : 0)).current;
  useEffect(() => {
    if (theme.reduceMotion) {
      progress.setValue(value ? 1 : 0);
      return;
    }
    Animated.timing(progress, { toValue: value ? 1 : 0, duration: theme.motion.fast || 160, easing: theme.easing, useNativeDriver: false }).start();
  }, [value, progress, theme.reduceMotion, theme.motion.fast, theme.easing]);
  const W = 50;
  const H = 30;
  const THUMB = 26;
  const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [2, W - THUMB - 2] });
  const backgroundColor = progress.interpolate({ inputRange: [0, 1], outputRange: [colors.lineStrong, colors.accent] });
  return (
    <Pressable
      onPress={() => onValueChange(!value)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      hitSlop={8}
      style={{ opacity: disabled ? 0.45 : 1 }}
    >
      <Animated.View style={{ width: W, height: H, borderRadius: H / 2, backgroundColor, justifyContent: 'center' }}>
        <Animated.View
          style={{
            width: THUMB,
            height: THUMB,
            borderRadius: THUMB / 2,
            backgroundColor: colors.panelSolid,
            boxShadow: theme.shadow.sm,
            transform: [{ translateX }],
          }}
        />
      </Animated.View>
    </Pressable>
  );
}

// -- buttons ------------------------------------------------------------------------

export type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'plain';

export function Button({
  label,
  onPress,
  variant = 'secondary',
  icon: Icon,
  disabled,
  busy,
  compact,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: LucideIcon;
  disabled?: boolean;
  busy?: boolean;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const { colors } = theme;
  const background =
    variant === 'primary' ? colors.accent : variant === 'destructive' ? colors.danger : variant === 'secondary' ? colors.panelSoft : 'transparent';
  const foreground =
    variant === 'primary' ? colors.onAccent : variant === 'destructive' ? colors.onAccent : variant === 'plain' ? colors.accent : colors.text;
  const inactive = disabled || busy;
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
      hitSlop={compact ? 4 : 0}
      style={({ pressed }) => [
        {
          minHeight: MIN_TOUCH,
          paddingHorizontal: compact ? 14 : 18,
          borderRadius: theme.radius.md,
          backgroundColor: background,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          opacity: inactive ? 0.5 : pressed ? 0.7 : 1,
        },
        style,
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={foreground} /> : Icon ? <Icon size={18} color={foreground} /> : null}
      <Text style={{ color: foreground, fontSize: 15, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

/** An action row in a card: icon + label, full width, ≥ 44 pt (quick actions). */
export function ActionRow({
  label,
  icon: Icon,
  onPress,
  disabled,
  busy,
  destructive,
  trailing,
}: {
  label: string;
  icon: LucideIcon;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  destructive?: boolean;
  trailing?: ReactNode;
}) {
  const { colors } = useTheme();
  const color = destructive ? colors.danger : colors.accent;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 52,
        paddingHorizontal: 16,
        opacity: disabled ? 0.45 : pressed ? 0.6 : 1,
        backgroundColor: pressed ? colors.panelSoft : 'transparent',
      })}
    >
      <Icon size={20} color={color} />
      <Text style={{ flex: 1, color: destructive ? colors.danger : colors.text, fontSize: 16 }}>{label}</Text>
      {busy ? <ActivityIndicator size="small" color={colors.textDim} /> : trailing}
    </Pressable>
  );
}

// -- segmented control -----------------------------------------------------------

export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  disabled,
  accessibilityLabel,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  const { colors } = theme;
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      style={{ flexDirection: 'row', backgroundColor: colors.panelSoft, borderRadius: theme.radius.md, padding: 3, opacity: disabled ? 0.5 : 1 }}
    >
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
            style={{
              flex: 1,
              minHeight: 38,
              borderRadius: theme.radius.sm,
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: 6,
              backgroundColor: selected ? colors.controlSelected : 'transparent',
              boxShadow: selected ? theme.shadow.sm : undefined,
            }}
            hitSlop={{ top: 3, bottom: 3 }}
          >
            <Text numberOfLines={1} adjustsFontSizeToFit style={{ color: selected ? colors.text : colors.textDim, fontSize: 14, fontWeight: selected ? '600' : '500' }}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// -- text field --------------------------------------------------------------------

export function TextField({ label, hint, error, style, ...props }: TextInputProps & { label: string; hint?: string; error?: string }) {
  const theme = useTheme();
  const { colors } = theme;
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: error ? colors.danger : focused ? colors.accent : colors.textDim, fontSize: 13, fontWeight: '500' }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={error}
        placeholderTextColor={colors.textMuted}
        selectionColor={colors.accent}
        cursorColor={colors.accent}
        {...props}
        onFocus={(e) => {
          setFocused(true);
          props.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          props.onBlur?.(e);
        }}
        underlineColorAndroid="transparent"
        style={[
          {
            minHeight: MIN_TOUCH,
            borderRadius: theme.radius.sm,
            borderWidth: 1,
            borderColor: error ? colors.danger : focused ? colors.accent : colors.lineStrong,
            // Focus ring like the Desktop's inputs: a soft accent halo (danger when invalid).
            boxShadow: focused ? `0 0 0 3px ${error ? colors.danger : colors.accentSoft}` : undefined,
            backgroundColor: colors.panelSolid,
            color: colors.text,
            fontSize: 16,
            paddingHorizontal: 12,
            paddingVertical: 8,
            // No platform chrome: web outline, Android padding/underline.
            includeFontPadding: false,
            textAlignVertical: props.multiline ? 'top' : 'center',
          },
          Platform.OS === 'web' ? ({ outlineStyle: 'none' } as unknown as TextStyle) : null,
          style,
        ]}
      />
      {error ? <Caption style={{ color: colors.danger }}>{error}</Caption> : hint ? <Caption>{hint}</Caption> : null}
    </View>
  );
}

// -- collapsible ------------------------------------------------------------------

/** "Technical details": collapsed by default, like the Desktop's <details>. */
export function Collapsible({ title, children, initiallyOpen = false }: { title: string; children: ReactNode; initiallyOpen?: boolean }) {
  const theme = useTheme();
  const [open, setOpen] = useState(initiallyOpen);
  const rotation = useRef(new Animated.Value(initiallyOpen ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(rotation, { toValue: open ? 1 : 0, duration: theme.motion.fast, easing: theme.easing, useNativeDriver: true }).start();
  }, [open, rotation, theme.motion.fast, theme.easing]);
  const rotate = rotation.interpolate({ inputRange: [0, 1], outputRange: ['-90deg', '0deg'] });
  return (
    <Card padded={false}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={title}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, paddingHorizontal: 16, opacity: pressed ? 0.6 : 1 })}
      >
        <Animated.View style={{ transform: [{ rotate }] }}>
          <ChevronDown size={18} color={theme.colors.textDim} />
        </Animated.View>
        <Text style={{ color: theme.colors.textDim, fontSize: 15, fontWeight: '500' }}>{title}</Text>
      </Pressable>
      {open ? (
        <View style={{ paddingBottom: 8 }}>
          <Divider inset={0} />
          {children}
        </View>
      ) : null}
    </Card>
  );
}

/** Centred empty-state text inside a card. */
export function Empty({ children, icon: Icon }: { children: string; icon?: LucideIcon }) {
  const { colors } = useTheme();
  return (
    <View style={{ alignItems: 'center', gap: 8, paddingVertical: 20, paddingHorizontal: 16 }}>
      {Icon ? <Icon size={28} color={colors.textMuted} /> : null}
      <Caption style={{ textAlign: 'center' }}>{children}</Caption>
    </View>
  );
}
