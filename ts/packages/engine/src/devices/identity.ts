// Which device a message is about (device_identity.py). Devices are keyed by
// their 12-hex UID (the WiFi MAC); messages may carry a short alias, a
// device_id or only a name, and a device first seen under a short alias is
// folded into the full UID once that is known (DeviceTable.purgeShortAliases).
import { type Dict, dictOr, strOr } from './py';

export const DEFAULT_DEVICE_NAME_PREFIX = 'NHOS-';
/** Firmware before v1.0.0 named itself "New Horizons OS-<UID>"; still the factory name. */
export const LEGACY_DEFAULT_DEVICE_NAME_PREFIXES: readonly string[] = ['New Horizons OS-'];
export const DEFAULT_DEVICE_NAME_PREFIXES: readonly string[] = [DEFAULT_DEVICE_NAME_PREFIX, ...LEGACY_DEFAULT_DEVICE_NAME_PREFIXES];

const HEX = /^[0-9A-F]+$/;

/** `_normalize_uid`: upper case; separators dropped when what is left is hex. */
export function normalizeUid(value: unknown): string {
  const raw = strOr(value).trim().toUpperCase();
  const collapsed = raw.replaceAll(':', '').replaceAll('-', '').replaceAll(' ', '');
  if (collapsed && HEX.test(collapsed)) return collapsed;
  return raw;
}

export function isFullHexUid(value: unknown): boolean {
  const normalized = normalizeUid(value);
  return normalized.length === 12 && HEX.test(normalized);
}

/** `_normalize_device_id`: like a UID, but a "0x" prefix keeps its lower-case x. */
export function normalizeDeviceId(value: unknown): string {
  const normalized = normalizeUid(value);
  return normalized.startsWith('0X') ? `0x${normalized.slice(2)}` : normalized;
}

/** `_device_uid_from_payload`: the first full UID among the candidates, else the first non-empty one. */
export function deviceUidFromPayload(fallback: unknown, payload: Dict): string {
  const system = dictOr(payload.system);
  const candidates = [
    payload.device_uid,
    payload.device_id,
    payload.dn,
    payload.id,
    system.device_uid,
    system.device_id,
    system.id,
    fallback,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeUid(candidate);
    if (isFullHexUid(normalized)) return normalized;
  }
  for (const candidate of candidates) {
    const normalized = normalizeUid(candidate);
    if (normalized) return normalized;
  }
  return '';
}

/** `_canonical_device_name`: a short factory name ("NHOS-45CCD0") becomes "NHOS-<full UID>". */
export function canonicalDeviceName(deviceName: string, deviceUid: string): string {
  if (
    DEFAULT_DEVICE_NAME_PREFIXES.some((prefix) => deviceName.startsWith(prefix)) &&
    deviceUid.length === 12 &&
    deviceUid.endsWith((deviceName.split('-').at(-1) ?? '').trim().toUpperCase()) &&
    !deviceName.endsWith(deviceUid)
  ) {
    return `${DEFAULT_DEVICE_NAME_PREFIX}${deviceUid}`;
  }
  return deviceName;
}

/** The device_id / id values (top level and under `system`) a payload maps to its UID. */
export function deviceIdCandidates(payload: Dict): string[] {
  const out: string[] = [];
  for (const key of ['device_id', 'id']) if (payload[key]) out.push(String(payload[key]));
  const system = dictOr(payload.system);
  for (const key of ['device_id', 'id']) if (system[key]) out.push(String(system[key]));
  return out;
}
