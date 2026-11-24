// The "Illustrated" interface's power and data paths for one device (Power
// card, Connection card). Nothing in the classic interface or on boards
// without a drawing (GCU LTS).
import { boardArtFor, connectionFlow, powerFlow } from '@nhgw/host';

import type { DeviceView } from '../../../shared/contract';
import { useAreaT } from '../../areas/i18n';
import { FlowPath } from '../../components/callout/FlowPath';
import { record } from '../../lib/deviceDetails';
import { useStudio } from '../../state/studio';
import { HERO_STRINGS } from './heroStrings';

function useIllustrated(device: DeviceView): boolean {
  const { uiStyle } = useStudio();
  return uiStyle === 'modern' && boardArtFor(device.hardwareModel) !== null;
}

export function PowerFlowView({ device, status }: { device: DeviceView; status: Record<string, unknown> }) {
  const ht = useAreaT(HERO_STRINGS);
  const illustrated = useIllustrated(device);
  const power = record(status.power);
  const battery = record(status.battery);
  const chargeState = String(power.charge_state ?? battery.charge_state ?? '');
  const graph = illustrated ? powerFlow({ chargerPresent: typeof power.charger_present === 'boolean' ? power.charger_present : null, chargeState }) : null;
  if (!graph) return null;
  const usb = graph.nodes.find((node) => node.id === 'usb')?.active ?? false;
  const percent = device.battery?.percent;
  return (
    <FlowPath
      graph={graph}
      ariaLabel={ht('flowPower')}
      labels={{
        usb: { title: ht('flowUsb'), value: usb ? ht('flowPowered') : ht('flowNoUsb') },
        charger: { title: ht('flowCharger'), value: chargeState === 'charging' ? ht('flowCharging') : chargeState === 'charge_done' ? ht('flowFull') : '–' },
        battery: { title: ht('flowBattery'), value: percent === null || percent === undefined ? '–' : `${percent}%` },
        system: { title: ht('flowSystem'), value: usb ? 'USB' : ht('flowBattery') },
      }}
    />
  );
}

export function ConnectionFlowView({ device, status, record: rec }: { device: DeviceView; status: Record<string, unknown>; record: Record<string, unknown> }) {
  const ht = useAreaT(HERO_STRINGS);
  const { snapshot } = useStudio();
  if (!useIllustrated(device)) return null;
  const hub = rec.client_type === 'hub' || status.transport === 'espnow';
  const findme = record(rec.findme ?? status.findme ?? record(status.runtime).findme);
  // Over Wi-Fi this Studio is the relay when it lists the device as its own;
  // then its own upstream is the server link. Otherwise it can't tell.
  const ours = !hub && device.online;
  const upstream = snapshot?.status.upstream;
  const graph = connectionFlow({ link: hub ? 'espnow' : 'wifi', deviceOnline: device.online, upstreamOnline: ours && upstream ? upstream === 'online' : null });
  const relayName = String((hub ? rec.gateway_id : findme.gateway_id) ?? rec.gateway_id ?? '') || '–';
  const serverOn = graph.nodes.find((node) => node.id === 'server')?.active ?? false;
  return (
    <FlowPath
      graph={graph}
      ariaLabel={ht('flowConnection')}
      labels={{
        device: { title: ht('flowDevice'), value: device.displayName },
        relay: { title: ht('flowRelay'), value: relayName },
        hub: { title: ht('flowHub'), value: relayName },
        server: { title: ht('flowServer'), value: serverOn ? ht('flowOnline') : ht('flowOffline') },
      }}
    />
  );
}
