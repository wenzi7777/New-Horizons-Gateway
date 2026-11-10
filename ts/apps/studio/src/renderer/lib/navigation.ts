// NH Studio's information architecture: every area of the final app is in
// the sidebar. Profiles, Apps and Tools are feature areas (../areas/*) with
// their own sub-paths (#/apps/studio/<project>).
// Routes live in location.hash (works from file:// in Electron).

export type AreaId = 'devices' | 'live' | 'recordings' | 'profiles' | 'apps' | 'tools' | 'settings';
export type DeviceTab = 'overview' | 'settings' | 'calibration';

export type NavItem = {
  id: AreaId;
  /** i18n key of the label. */
  label: 'navDeviceList' | 'navLive' | 'navRecordings' | 'navProfiles' | 'navApps' | 'navTools' | 'navSettings';
  /** Placeholder for a later version (v2). */
  later: boolean;
  /** Pinned to the bottom of the sidebar. */
  bottom: boolean;
};

export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'devices', label: 'navDeviceList', later: false, bottom: false },
  { id: 'live', label: 'navLive', later: false, bottom: false },
  { id: 'recordings', label: 'navRecordings', later: false, bottom: false },
  { id: 'profiles', label: 'navProfiles', later: false, bottom: false },
  { id: 'apps', label: 'navApps', later: false, bottom: false },
  { id: 'tools', label: 'navTools', later: false, bottom: false },
  { id: 'settings', label: 'navSettings', later: false, bottom: true },
];

export const DEVICE_TABS: readonly DeviceTab[] = ['overview', 'settings', 'calibration'];

export type Route =
  | { area: 'devices'; uid: string | null; tab: DeviceTab }
  | { area: 'live'; uids: string[] }
  | { area: 'recordings'; id: string | null }
  | { area: 'profiles'; path: string[] }
  | { area: 'apps'; path: string[] }
  | { area: 'tools'; path: string[] }
  | { area: 'settings'; section: string | null };

export const DEFAULT_ROUTE: Route = { area: 'devices', uid: null, tab: 'overview' };

/** "#/devices/3C84.../settings", "#/live/A,B", "#/recordings/<id with slashes>", "#/settings". */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  const [area = '', ...rest] = path.split('/');
  switch (area) {
    case 'devices': {
      const uid = rest[0] ? decodeURIComponent(rest[0]) : null;
      const tab = DEVICE_TABS.includes(rest[1] as DeviceTab) ? (rest[1] as DeviceTab) : 'overview';
      return { area: 'devices', uid, tab };
    }
    case 'live':
      return { area: 'live', uids: rest[0] ? rest[0].split(',').map(decodeURIComponent).filter(Boolean).slice(0, 4) : [] };
    case 'recordings':
      return { area: 'recordings', id: rest.length ? rest.map(decodeURIComponent).join('/') : null };
    case 'profiles':
    case 'apps':
    case 'tools':
      return { area, path: rest.map(decodeURIComponent).filter(Boolean) } as Route;
    case 'settings':
      return { area: 'settings', section: rest[0] ? decodeURIComponent(rest[0]) : null };
    default:
      return DEFAULT_ROUTE;
  }
}

export function formatRoute(route: Route): string {
  switch (route.area) {
    case 'devices':
      if (!route.uid) return '#/devices';
      return `#/devices/${encodeURIComponent(route.uid)}${route.tab === 'overview' ? '' : `/${route.tab}`}`;
    case 'live':
      return route.uids.length ? `#/live/${route.uids.map(encodeURIComponent).join(',')}` : '#/live';
    case 'recordings':
      return route.id ? `#/recordings/${route.id.split('/').map(encodeURIComponent).join('/')}` : '#/recordings';
    case 'settings':
      return route.section ? `#/settings/${encodeURIComponent(route.section)}` : '#/settings';
    default:
      return route.path.length ? `#/${route.area}/${route.path.map(encodeURIComponent).join('/')}` : `#/${route.area}`;
  }
}

/** Live view: at most four devices side by side. */
export const MAX_LIVE_DEVICES = 4;

/** Toggle a device in the live selection, keeping order and the limit. */
export function toggleLiveDevice(selection: readonly string[], uid: string): string[] {
  if (selection.includes(uid)) return selection.filter((u) => u !== uid);
  if (selection.length >= MAX_LIVE_DEVICES) return [...selection];
  return [...selection, uid];
}

/** Grid columns for n live panels (1, 2, 3 side by side; 4 as 2×2). */
export function liveColumns(count: number): number {
  if (count <= 1) return 1;
  if (count === 4) return 2;
  return Math.min(count, 3);
}
