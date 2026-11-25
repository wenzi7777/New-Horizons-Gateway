// The IO Visualizer on a phone (Studio's BoardIoModal, the Desktop's
// TerminalPage BoardIoModal): the board's overview picture, then the FPC pins
// to tap in matrix order, applied with set_matrix_layout.
import { Stack } from 'expo-router';
import { Cpu } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Image, type ImageSourcePropType, Pressable, Text, View } from 'react-native';
import { boardArtFor, boardPinsFor, togglePin, type BoardPinSlot, type BoardPins } from '@nhgw/host';

import { errorText } from '../../i18n/strings';
import { useConfirm, useToast } from '../components/feedback';
import { PinMap } from '../components/PinMap';
import { Body, Button, Caption, Card, Empty, Mono, Notice, Screen, SectionHeader } from '../components/primitives';
import { useI18n } from '../i18n';
import { useSettings, useStore, useStoreSelector } from '../store';
import { useAfterTransition } from '../useAfterTransition';
import { useTheme } from '../theme';

const ARTWORK: Record<BoardPins['artwork'], ImageSourcePropType> = {
  v10f: require('../../../assets/boards/VDCTLRv10F20264OVERVIEW.png'),
  v15f: require('../../../assets/boards/VDCTLRv15F20267OVERVIEW.png'),
  v20f: require('../../../assets/boards/TIACTLAv20F202610OVERVIEW.png'),
  gcu_v21: require('../../../assets/boards/VDCTLV21GCULTSOVERVIEW.png'),
  gcu_v22c: require('../../../assets/boards/VDCTLV22CGCULTSOVERVIEW.png'),
  gcu_v23d: require('../../../assets/boards/VDCTLV23DGCULTSOVERVIEW.png'),
};

// The artwork is an A4 page; at full width it would fill a phone screen, so it
// gets a fixed height and is fitted inside it.
const ARTWORK_HEIGHT = 280;

function PinList({ heading, pins, chosen, onToggle }: { heading: string; pins: BoardPinSlot[]; chosen: number[]; onToggle: (pin: BoardPinSlot) => void }) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: 4 }}>
      <SectionHeader title={heading} />
      <Card padded={false}>
        {pins.map((pin, index) => {
          const selectable = Boolean(pin.role) && pin.gpio !== undefined;
          const order = selectable ? chosen.indexOf(Number(pin.gpio)) + 1 : 0;
          const selected = order > 0;
          return (
            <Pressable
              key={`${heading}-${index}`}
              disabled={!selectable}
              onPress={() => onToggle(pin)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: selected, disabled: !selectable }}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                minHeight: 44,
                paddingHorizontal: 16,
                backgroundColor: selected ? colors.accentSoft : pressed ? colors.panelSoft : 'transparent',
                borderTopWidth: index === 0 ? 0 : 0.5,
                borderTopColor: colors.line,
              })}
            >
              <Text style={{ width: 24, textAlign: 'center', fontVariant: ['tabular-nums'], fontWeight: selected ? '700' : '400', color: selected ? colors.accent : colors.textMuted }}>
                {selected ? order : index + 1}
              </Text>
              <Text style={{ flex: 1, fontFamily: 'monospace', fontSize: 15, color: selectable ? colors.text : colors.textMuted }}>{pin.label}</Text>
              <Text style={{ fontFamily: 'monospace', fontSize: 12, color: colors.textMuted }}>{pin.gpio !== undefined ? `GPIO ${pin.gpio}` : '-'}</Text>
            </Pressable>
          );
        })}
      </Card>
    </View>
  );
}

export function IoScreen({ uid }: { uid: string }) {
  // Only what this screen shows: the device's fps / battery ticking must not
  // redraw the board and its pins.
  const device = useStoreSelector((s) => {
    const d = s.devices().find((entry) => entry.uid === uid);
    return d ? { displayName: d.displayName, hardwareModel: d.hardwareModel, online: d.online, pins: d.pins ?? null } : null;
  });
  const store = useStore();
  const toast = useToast();
  const confirm = useConfirm();
  const { t, locale } = useI18n();
  const hardwareModel = device?.hardwareModel;
  const board = useMemo(() => boardPinsFor(hardwareModel), [hardwareModel]);
  const { uiStyle } = useSettings();
  // Illustrated: the FPC contacts fanned out to tappable labels, in place of
  // the artwork and the two pin lists.
  const art = useMemo(() => (uiStyle === 'modern' ? boardArtFor(hardwareModel) : null), [uiStyle, hardwareModel]);
  const onDevice = device?.pins ?? null;
  const [analog, setAnalog] = useState<number[]>(() => (onDevice?.analog.length ? onDevice.analog : board.defaultAnalogPins));
  const [select, setSelect] = useState<number[]>(() => (onDevice?.select.length ? onDevice.select : board.defaultSelectPins));
  const [dirty, setDirty] = useState(false);
  // The pin map mounts after the push animation (see useAfterTransition).
  const shown = useAfterTransition();
  const [busy, setBusy] = useState(false);

  // Follow the device until the user starts picking.
  // (onDevice keeps its identity while unchanged: useStoreSelector shares it.)
  useEffect(() => {
    if (dirty || !onDevice) return;
    if (onDevice.analog.length) setAnalog(onDevice.analog);
    if (onDevice.select.length) setSelect(onDevice.select);
  }, [onDevice, dirty]);

  const toggle = useCallback((pin: BoardPinSlot) => {
    if (!pin.role || pin.gpio === undefined) return;
    setDirty(true);
    if (pin.role === 'analog') setAnalog((current) => togglePin(current, Number(pin.gpio)));
    else setSelect((current) => togglePin(current, Number(pin.gpio)));
  }, []);

  if (!device) {
    return (
      <Screen topInset={false}>
        <Stack.Screen options={{ title: t('ioTitle') }} />
        <Card>
          <Empty>{t('deviceGone')}</Empty>
        </Card>
      </Screen>
    );
  }

  const artwork = ARTWORK[board.artwork];
  const incomplete = !analog.length || !select.length;

  const apply = async () => {
    const ok = await confirm({
      title: t('ioConfirmTitle'),
      message: t('ioConfirmMessage', { device: device.displayName, rows: analog.length, cols: select.length }),
      confirmLabel: t('ioApply'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const outcome = await store.run(uid, { kind: 'matrix_layout', analogPins: analog, selectPins: select });
      if (outcome.ok) {
        setDirty(false);
        toast.show(t('ioApplied'));
      } else {
        toast.show(t('actionFailed', { error: errorText(locale, outcome.message) }), 'danger');
      }
    } catch (error) {
      toast.show(t('actionFailed', { error: String((error as Error)?.message ?? error) }), 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen topInset={false}>
      <Stack.Screen options={{ title: t('ioTitle') }} />

      <Card padded={false}>
        <View style={{ paddingVertical: 8, paddingHorizontal: art ? 6 : 0 }}>
          {art && !shown ? (
            <View style={{ height: ARTWORK_HEIGHT }} />
          ) : art ? (
            <PinMap art={art} analogSlots={board.analogPinSlots} digitalSlots={board.digitalPinSlots} analogChosen={analog} selectChosen={select} onToggle={toggle} accessibilityLabel={board.hardwareModel} />
          ) : (
            <Image source={artwork} accessibilityLabel={board.hardwareModel} resizeMode="contain" style={{ width: '100%', height: ARTWORK_HEIGHT }} />
          )}
        </View>
      </Card>

      <Card>
        <Caption>{t('ioIntro')}</Caption>
        <View style={{ gap: 6 }}>
          <Body dim>{t('ioAnalog')}</Body>
          <Mono>{analog.join(',') || '-'}</Mono>
          <Body dim>{t('ioSelect')}</Body>
          <Mono>{select.join(',') || '-'}</Mono>
        </View>
        {onDevice ? <Caption>{t('ioOnDevice', { analog: onDevice.analog.join(',') || '-', select: onDevice.select.join(',') || '-' })}</Caption> : null}
        {incomplete ? <Notice tone="warning">{t('ioNeedBoth')}</Notice> : null}
        <Button label={t('ioApply')} variant="primary" icon={Cpu} busy={busy} disabled={incomplete || !device.online} onPress={() => void apply()} />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button
            label={t('ioDefaults')}
            style={{ flex: 1 }}
            onPress={() => {
              setDirty(true);
              setAnalog(board.defaultAnalogPins);
              setSelect(board.defaultSelectPins);
            }}
          />
          <Button
            label={t('ioClear')}
            style={{ flex: 1 }}
            onPress={() => {
              setDirty(true);
              setAnalog([]);
              setSelect([]);
            }}
          />
        </View>
      </Card>

      {art ? null : (
        <>
          <PinList heading={board.analogPinHeading} pins={board.analogPinSlots} chosen={analog} onToggle={toggle} />
          <PinList heading={board.digitalPinHeading} pins={board.digitalPinSlots} chosen={select} onToggle={toggle} />
        </>
      )}
    </Screen>
  );
}
