// Toasts and confirm dialogs, app-wide.
//   const toast = useToast(); toast.show('Saved') / toast.show(msg, 'danger')
//   const confirm = useConfirm(); if (await confirm({ title, message, destructive: true })) …

import { CircleAlert, CircleCheck, Info } from 'lucide-react-native';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useI18n } from '../i18n';
import { cardStyle, useTheme } from '../theme';
import { Body, Button, MAX_CONTENT_WIDTH } from './primitives';

// -- toast ----------------------------------------------------------------------

type ToastTone = 'success' | 'danger' | 'info';
type ToastItem = { id: number; message: string; tone: ToastTone };
type ToastApi = { show: (message: string, tone?: ToastTone) => void };

const ToastContext = createContext<ToastApi | null>(null);

function ToastView({ item, onDone }: { item: ToastItem; onDone: () => void }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const animation = Animated.sequence([
      Animated.timing(progress, { toValue: 1, duration: theme.motion.med, easing: theme.easing, useNativeDriver: true }),
      Animated.delay(item.tone === 'danger' ? 4200 : 2400),
      Animated.timing(progress, { toValue: 0, duration: theme.motion.med, easing: theme.easing, useNativeDriver: true }),
    ]);
    animation.start(({ finished }) => finished && onDone());
    return () => animation.stop();
  }, [item, onDone, progress, theme.motion.med, theme.easing]);
  const Icon = item.tone === 'success' ? CircleCheck : item.tone === 'danger' ? CircleAlert : Info;
  const color = item.tone === 'success' ? theme.colors.success : item.tone === 'danger' ? theme.colors.danger : theme.colors.accent;
  return (
    <Animated.View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 16,
        right: 16,
        bottom: insets.bottom + 72,
        alignItems: 'center',
        opacity: progress,
        transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [theme.reduceMotion ? 0 : 16, 0] }) }],
      }}
    >
      <Pressable
        onPress={onDone}
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        style={[
          cardStyle(theme),
          {
            backgroundColor: theme.colors.panelSolid,
            boxShadow: theme.shadow.md,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            paddingHorizontal: 16,
            paddingVertical: 12,
            minHeight: 48,
            maxWidth: 560,
          },
        ]}
      >
        <Icon size={20} color={color} />
        <Text style={{ color: theme.colors.text, fontSize: 15, flexShrink: 1 }}>{item.message}</Text>
      </Pressable>
    </Animated.View>
  );
}

// -- confirm --------------------------------------------------------------------

export type ConfirmOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  destructive?: boolean;
};
type ConfirmRequest = ConfirmOptions & { resolve: (ok: boolean) => void };

const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

function ConfirmDialog({ request, onClose }: { request: ConfirmRequest | null; onClose: (ok: boolean) => void }) {
  const theme = useTheme();
  const { t } = useI18n();
  return (
    <Modal
      visible={!!request}
      transparent
      animationType={theme.reduceMotion ? 'none' : 'fade'}
      onRequestClose={() => onClose(false)}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <Pressable
        accessibilityLabel={t('cancel')}
        onPress={() => onClose(false)}
        style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}
      >
        {/* Scrim: the page background, faded (no colour outside the tokens). */}
        <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: theme.colors.bg, opacity: 0.78 }} />
        {request ? (
          <Pressable
            accessibilityRole="none"
            onPress={() => undefined}
            style={[cardStyle(theme), { backgroundColor: theme.colors.panelSolid, boxShadow: theme.shadow.md, width: '100%', maxWidth: Math.min(MAX_CONTENT_WIDTH, 440), padding: 20, gap: 12 }]}
          >
            <Text accessibilityRole="header" style={{ color: theme.colors.text, fontSize: 18, fontWeight: '600' }}>
              {request.title}
            </Text>
            {request.message ? <Body dim>{request.message}</Body> : null}
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
              <Button label={t('cancel')} variant="secondary" onPress={() => onClose(false)} />
              <Button
                label={request.confirmLabel ?? t('ok')}
                variant={request.destructive ? 'destructive' : 'primary'}
                onPress={() => onClose(true)}
              />
            </View>
          </Pressable>
        ) : null}
      </Pressable>
    </Modal>
  );
}

// -- provider --------------------------------------------------------------------

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastItem | null>(null);
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const nextId = useRef(1);

  const show = useCallback((message: string, tone: ToastTone = 'success') => {
    setToast({ id: nextId.current++, message, tone });
  }, []);
  const toastApi = useMemo(() => ({ show }), [show]);
  const dismissToast = useCallback(() => setToast(null), []);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setRequest((previous) => {
          previous?.resolve(false);
          return { ...options, resolve };
        });
      }),
    [],
  );
  const close = useCallback(
    (ok: boolean) => {
      request?.resolve(ok);
      setRequest(null);
    },
    [request],
  );

  return (
    <ToastContext.Provider value={toastApi}>
      <ConfirmContext.Provider value={confirm}>
        <View style={{ flex: 1 }}>
          {children}
          {toast ? <ToastView key={toast.id} item={toast} onDone={dismissToast} /> : null}
        </View>
        <ConfirmDialog request={request} onClose={close} />
      </ConfirmContext.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) throw new Error('FeedbackProvider missing');
  return value;
}

export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  const value = useContext(ConfirmContext);
  if (!value) throw new Error('FeedbackProvider missing');
  return value;
}
