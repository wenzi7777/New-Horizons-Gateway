// Devices: the managed devices (grouped) and Nearby on the left, the selected
// device on the right with Overview / Settings / Calibration tabs.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Radar } from 'lucide-react';

import type { DeviceView } from '../../shared/contract';
import { BatteryIndicator, StatusDot, useConfirm } from '../components/ui';
import { connectionRank, connectionStateOf } from '../lib/deviceStatus';
import { formatAgo } from '../lib/format';
import { DEVICE_TABS, type DeviceTab, type Route } from '../lib/navigation';
import { useStudio, type T } from '../state/studio';
import { DeviceOverview } from './device/DeviceOverview';
import { DeviceSettings } from './device/DeviceSettings';
import { DeviceCalibration } from './device/DeviceCalibration';

type Props = { route: Extract<Route, { area: 'devices' }>; navigate: (route: Route) => void };

export function batteryText(t: T, device: Pick<DeviceView, 'battery'>): string {
  const b = device.battery;
  if (!b || b.percent === null) return '';
  return b.charging ? `${b.percent}% · ${t('batteryCharging')}` : `${b.percent}%`;
}

export function modeLabel(t: T, mode: string): string {
  if (mode === 'normal' || mode === '') return t('modeNormal');
  if (mode === 'maintenance') return t('modeMaintenance');
  if (mode === 'safe' || mode === 'safe_maintenance') return t('modeSafe');
  return mode;
}

/** Managed devices grouped by group name ("" last), online first within a group. */
function groupDevices(devices: readonly DeviceView[]): { group: string; items: DeviceView[] }[] {
  const map = new Map<string, DeviceView[]>();
  for (const d of devices) {
    const list = map.get(d.group) ?? [];
    list.push(d);
    map.set(d.group, list);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
    .map(([group, items]) => ({
      group,
      items: [...items].sort(
        (x, y) =>
          connectionRank({ connectionState: connectionStateOf(x), mode: x.mode }) - connectionRank({ connectionState: connectionStateOf(y), mode: y.mode }) ||
          x.displayName.localeCompare(y.displayName),
      ),
    }));
}

export function DevicesPage({ route, navigate }: Props) {
  const { snapshot, t, exec, api } = useStudio();
  const [confirmUi, confirm] = useConfirm();
  const devices = snapshot?.devices ?? [];
  const nearby = snapshot?.nearby ?? [];
  const groups = useMemo(() => groupDevices(devices), [devices]);
  const [adopting, setAdopting] = useState<string>('');
  const [discovering, setDiscovering] = useState(false);
  const now = Date.now();
  const selected = route.uid ? devices.find((d) => d.uid === route.uid) ?? null : null;

  useTakenOverToasts(devices);

  // Add a free device, or take one over from the relay using it (Studio, Pocket or headless alike).
  const adopt = async (uid: string, name: string, from = '') => {
    if (from) {
      const ok = await confirm({ title: t('takeOverTitle', { device: name }), message: t('takeOverMessage', { relay: from }), confirmLabel: t('takeOverDevice') });
      if (!ok) return;
    }
    setAdopting(uid);
    const label = from ? t('takeOverDevice') : t('addDevice');
    const success = from ? t('deviceTakenOver', { device: name }) : t('deviceAdded', { device: name });
    const outcome = await exec(label, () => api.adopt(uid), { uid, success });
    setAdopting('');
    if (outcome.ok) navigate({ area: 'devices', uid, tab: 'overview' });
  };

  // Devices answer a probe directly, so this finds them even where the access
  // point does not pass their own broadcasts to this computer.
  const discover = async () => {
    setDiscovering(true);
    await exec(t('discoverNearby'), () => api.discoverNearby(), { success: t('discoverNearbySent') });
    // Answers arrive within a few seconds (each device answers at most every 5 s).
    setTimeout(() => setDiscovering(false), 3000);
  };

  return (
    <div className="split">
      {confirmUi}
      <section className="split-list" aria-labelledby="my-devices-title">
        <div className="list-head">
          <h2 id="my-devices-title">{t('myDevices')}</h2>
          <span className="muted">{devices.length}</span>
        </div>
        {devices.length === 0 ? <p className="empty">{t('noDevices')}</p> : null}
        {groups.map(({ group, items }) => (
          <div key={group || '-'} className="device-group">
            <h3 className="group-title">{group || t('ungrouped')}</h3>
            <ul className="device-list" role="list">
              {items.map((d) => {
                const active = d.uid === route.uid;
                const state = connectionStateOf(d);
                return (
                  <li key={d.uid}>
                    <button
                      type="button"
                      className={`device-row${active ? ' active' : ''}${d.online ? '' : ' is-offline'}`}
                      aria-current={active ? 'true' : undefined}
                      onClick={() => navigate({ area: 'devices', uid: d.uid, tab: route.uid === d.uid ? route.tab : 'overview' })}
                    >
                      <StatusDot state={d.mode === 'maintenance' && d.online ? 'maintenance' : state === 'online' ? 'online' : 'offline'} />
                      <span className="device-main">
                        <span className="device-title">
                          <strong>{d.displayName}</strong>
                          {d.recording.enabled ? <span className="tag rec">{t('recBadge')}</span> : null}
                          {d.takenOver ? <span className="tag waiting">{t('takenOverTag')}</span> : null}
                        </span>
                        <span className="device-detail">
                          {d.takenOver
                            ? takenOverText(t, d)
                            : d.online
                              ? t('fpsValue', { fps: d.fps })
                              : d.lastSeenMs
                                ? t('lastSeen', { time: formatAgo(d.lastSeenMs, now) })
                                : t('deviceOffline')}
                          {d.mode !== 'normal' && d.online && !d.takenOver ? ` · ${modeLabel(t, d.mode)}` : ''}
                        </span>
                      </span>
                      {d.battery ? <BatteryIndicator percent={d.battery.percent} charging={d.battery.charging} label={`${t('infoBattery')}: ${batteryText(t, d)}`} /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}

        <div className="list-head nearby-head">
          <h2>{t('nearbyTitle')}</h2>
          <span className="list-head-trail">
            <span className="muted">{nearby.length}</span>
            <button className="button tiny" type="button" disabled={discovering} onClick={() => void discover()}>
              <Radar size={13} aria-hidden="true" />
              {t('discoverNearby')}
            </button>
          </span>
        </div>
        <p className="list-hint">{t('nearbyHint')}</p>
        {nearby.length === 0 ? <p className="empty">{t('noNearbyDevices')}</p> : null}
        <ul className="device-list" role="list">
          {nearby.map((n) => (
            <li key={n.uid} className="device-row static">
              <StatusDot state={n.attachedTo ? 'disabled' : 'online'} />
              <span className="device-main">
                <span className="device-title">
                  <strong>{n.name}</strong>
                </span>
                <span className="device-detail mono">{n.ip}</span>
                {n.attachedTo ? (
                  <span className="device-detail" title={t('attachedNote')}>
                    {t('attachedTo', { name: n.attachedTo })}
                  </span>
                ) : null}
              </span>
              {n.attachedTo ? (
                <button
                  className="button tiny"
                  type="button"
                  disabled={adopting !== ''}
                  onClick={() => void adopt(n.uid, n.name, n.attachedTo)}
                  aria-label={`${t('takeOverDevice')} ${n.name}`}
                >
                  {adopting === n.uid ? t('takingOver') : t('takeOverDevice')}
                </button>
              ) : (
                <button className="button tiny" type="button" disabled={adopting !== ''} onClick={() => void adopt(n.uid, n.name)} aria-label={`${t('addDevice')} ${n.name}`}>
                  <Plus size={13} aria-hidden="true" />
                  {adopting === n.uid ? t('addingDevice') : t('addDevice')}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="split-detail">
        {route.uid && !selected ? (
          <p className="empty">{t('deviceGone')}</p>
        ) : selected ? (
          <DeviceDetail device={selected} tab={route.tab} navigate={navigate} />
        ) : (
          <div className="empty-state">
            <h2>{t('selectDevice')}</h2>
            <p>{t('selectDeviceCopy')}</p>
          </div>
        )}
      </section>
    </div>
  );
}

function TakenOverNotice({ device }: { device: DeviceView }) {
  const { t, exec, api } = useStudio();
  const [busy, setBusy] = useState(false);
  return (
    <div className="notice warning taken-over-notice" role="status">
      <span>
        <strong>{takenOverText(t, device)}</strong> {t('takenOverCopy')}
      </span>
      <button
        className="button tiny"
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await exec(t('takeBack'), () => api.adopt(device.uid), { uid: device.uid, success: t('deviceTakenOver', { device: device.displayName }) });
          setBusy(false);
        }}
      >
        {busy ? t('takingOver') : t('takeBack')}
      </button>
    </div>
  );
}

function takenOverText(t: T, d: DeviceView): string {
  return d.takenOverBy ? t('takenOverBy', { name: d.takenOverBy }) : t('takenOverByUnknown');
}

/** One toast when a listed device is taken over by another relay. */
function useTakenOverToasts(devices: DeviceView[]) {
  const { t, toast } = useStudio();
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const now = new Set(devices.filter((d) => d.takenOver).map((d) => d.uid));
    // The first snapshot is the state at launch, not news.
    if (seen.current !== null) {
      for (const d of devices) {
        if (d.takenOver && !seen.current.has(d.uid)) {
          toast('info', t('takenOverToast', { device: d.displayName, name: d.takenOverBy || t('takenOverByUnknown') }));
        }
      }
    }
    seen.current = now;
  }, [devices, t, toast]);
}

const TAB_LABEL = { overview: 'tabOverview', settings: 'tabSettings', calibration: 'tabCalibration' } as const;

function DeviceDetail({ device, tab, navigate }: { device: DeviceView; tab: DeviceTab; navigate: (route: Route) => void }) {
  const { t } = useStudio();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const go = (next: DeviceTab) => navigate({ area: 'devices', uid: device.uid, tab: next });
  return (
    <div className="device-detail-view">
      <header className="detail-head">
        <div>
          <h2>{device.displayName}</h2>
          <p className="muted mono">
            {device.uid} · {device.hardwareModel} · {device.firmwareVersion}
          </p>
        </div>
        <span className={`status-pill ${device.online ? 'live' : 'waiting'}`}>
          <StatusDot state={device.online ? 'online' : 'offline'} />
          {device.online ? t('deviceOnline') : t('deviceOffline')}
        </span>
      </header>
      {device.takenOver ? <TakenOverNotice device={device} /> : null}
      <div className="tabs" role="tablist" aria-label={t('deviceTabs')}>
        {DEVICE_TABS.map((id, index) => (
          <button
            key={id}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            id={`tab-${id}`}
            type="button"
            role="tab"
            aria-selected={tab === id}
            aria-controls={`panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className={tab === id ? 'active' : ''}
            onClick={() => go(id)}
            onKeyDown={(event) => {
              const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
              if (!delta) return;
              event.preventDefault();
              const next = DEVICE_TABS[(index + delta + DEVICE_TABS.length) % DEVICE_TABS.length]!;
              go(next);
              tabRefs.current[DEVICE_TABS.indexOf(next)]?.focus();
            }}
          >
            {t(TAB_LABEL[id])}
          </button>
        ))}
      </div>
      <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} className="tab-panel">
        {tab === 'overview' ? (
          <DeviceOverview device={device} navigate={navigate} />
        ) : tab === 'settings' ? (
          <DeviceSettings key={device.uid} device={device} />
        ) : (
          <DeviceCalibration device={device} />
        )}
      </div>
    </div>
  );
}
