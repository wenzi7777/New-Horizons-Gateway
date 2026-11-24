// The "Illustrated" device overview: the board (v1.0.F / v1.5.F / v2.0.F) with
// its live values pointing at the parts they come from. Each value opens the
// place where it is set. Null on boards without a drawing (GCU LTS): the
// overview keeps its Status card then.
import { useMemo } from 'react';
import { Cpu, Gauge, Grid3x3, Lightbulb, Wifi, WifiOff } from 'lucide-react';
import { boardArtFor } from '@nhgw/host';

import type { DeviceView } from '../../../shared/contract';
import { useAreaT } from '../../areas/i18n';
import { CalloutDiagram, type CalloutItem } from '../../components/callout/CalloutDiagram';
import { BatteryGlyph } from '../../components/ui';
import { record } from '../../lib/deviceDetails';
import { formatAgo } from '../../lib/format';
import type { Route } from '../../lib/navigation';
import { useStudio } from '../../state/studio';
import { modeLabel } from '../DevicesPage';
import { indicatorsOf } from './DeviceHardware';
import { HERO_STRINGS } from './heroStrings';

export function DeviceHero({ device, navigate }: { device: DeviceView; navigate: (route: Route) => void }) {
  const { t, snapshot } = useStudio();
  const ht = useAreaT(HERO_STRINGS);
  const art = boardArtFor(device.hardwareModel);
  const detail = snapshot?.deviceDetails[device.uid];
  const status = record(detail?.status ?? record(detail?.record).last_status);

  const items = useMemo<CalloutItem[]>(() => {
    const settings = (section: string) => () => navigate({ area: 'devices', uid: device.uid, tab: 'settings', section });
    const out: CalloutItem[] = [];
    out.push({
      id: 'connection',
      target: 'antenna',
      icon: device.online ? <Wifi size={14} aria-hidden="true" /> : <WifiOff size={14} aria-hidden="true" />,
      title: ht('calloutConnection'),
      value: device.takenOver ? t('takenOverTag') : device.online ? t('deviceOnline') : t('deviceOffline'),
      detail: device.takenOver
        ? device.takenOverBy ? t('takenOverBy', { name: device.takenOverBy }) : t('takenOverByUnknown')
        : device.online
          ? ht('connectedHere')
          : device.lastSeenMs ? t('lastSeen', { time: formatAgo(device.lastSeenMs, Date.now()) }) : undefined,
      tone: device.takenOver || device.streamBlocked ? 'warn' : device.online ? 'ok' : 'muted',
      onSelect: settings('connection'),
    });
    out.push({
      id: 'firmware',
      target: 'mcu',
      icon: <Cpu size={14} aria-hidden="true" />,
      title: ht('calloutFirmware'),
      value: device.firmwareVersion || ht('noData'),
      detail: modeLabel(t, device.mode),
      tone: device.mode && device.mode !== 'normal' ? 'warn' : 'ok',
      onSelect: settings('update'),
    });
    if (device.battery && device.battery.percent !== null) {
      const percent = device.battery.percent;
      out.push({
        id: 'battery',
        target: 'battery',
        icon: <BatteryGlyph percent={device.battery.percent} charging={device.battery.charging} className="callout-battery" />,
        title: ht('calloutBattery'),
        value: `${percent}%`,
        detail: device.battery.charging ? t('batteryCharging') : ht('batteryOnBattery'),
        tone: percent <= 10 && !device.battery.charging ? 'danger' : percent <= 20 && !device.battery.charging ? 'warn' : 'ok',
        onSelect: settings('hardware'),
      });
    }
    if (device.vref) {
      const vref = device.vref;
      out.push({
        id: 'vref',
        target: 'vref',
        icon: <Gauge size={14} aria-hidden="true" />,
        title: ht('calloutVref'),
        value: vref.mv !== null ? `${Math.round(vref.mv)} mV` : ht('noData'),
        detail: vref.mode === 'auto' ? ht('readingAuto') : vref.mode === 'conductance' ? ht('readingConductance') : ht('readingRaw'),
        tone: vref.zone === 'risk' ? 'danger' : vref.zone === 'near' ? 'warn' : 'ok',
        onSelect: settings('hardware'),
      });
    }
    // The matrix is rows on the analog FPC times columns on the digital one:
    // one label, its line split to both connectors.
    const rows = device.pins?.analog.length ?? device.matrix?.rows;
    const cols = device.pins?.select.length ?? device.matrix?.cols;
    out.push({
      id: 'matrix',
      target: 'analogFpc',
      branches: ['digitalFpc'],
      icon: <Grid3x3 size={14} aria-hidden="true" />,
      title: ht('calloutMatrix'),
      value: rows !== undefined && cols !== undefined ? ht('pinsValue', { rows, cols }) : ht('noData'),
      detail: device.online ? t('fpsValue', { fps: device.fps }) : ht('noData'),
      tone: device.online ? 'ok' : 'muted',
      onSelect: settings('hardware'),
    });
    const indicators = indicatorsOf(status);
    const boardLed = record(indicators.board_led);
    const oled = record(indicators.oled);
    if (Object.keys(boardLed).length || Object.keys(oled).length) {
      const brightness = Number(boardLed.brightness);
      const ledOn = Number.isFinite(brightness) ? brightness > 0 : boardLed.enabled !== false;
      out.push({
        id: 'lights',
        target: 'led',
        icon: <Lightbulb size={14} aria-hidden="true" />,
        title: ht('calloutLights'),
        value: ledOn ? (Number.isFinite(brightness) ? `${Math.round(brightness * 100)}%` : ht('lightOn')) : ht('lightOff'),
        detail: Object.keys(oled).length ? (oled.mode && oled.mode !== 'off' ? ht('oledOn') : ht('oledOff')) : undefined,
        tone: ledOn ? 'ok' : 'muted',
        onSelect: settings('hardware'),
      });
    }
    return out;
  }, [device, status, ht, t, navigate]);

  if (!art) return null;
  return <CalloutDiagram art={art} items={items} ariaLabel={ht('heroLabel')} />;
}
