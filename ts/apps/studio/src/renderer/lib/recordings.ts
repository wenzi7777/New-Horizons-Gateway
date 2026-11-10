// The recordings table: grouped by device, then by day within a device.

import type { RecordingSummary } from '../../shared/contract';
import { groupByDay, type DayGroup } from './format';

export type RecordingGroupMode = 'device' | 'day';

export type DeviceRecordingGroup = { uid: string; deviceName: string; bytes: number; days: DayGroup<RecordingSummary>[] };

/** Devices with the newest recording first; each device's recordings by day, newest first. */
export function groupRecordingsByDevice(recordings: readonly RecordingSummary[]): DeviceRecordingGroup[] {
  const byDevice = new Map<string, RecordingSummary[]>();
  for (const r of recordings) {
    const list = byDevice.get(r.uid) ?? [];
    list.push(r);
    byDevice.set(r.uid, list);
  }
  const groups = [...byDevice.entries()].map(([uid, items]) => {
    const days = groupByDay(items, (r) => r.startedAtMs);
    const newest = days[0]?.items[0];
    return { uid, deviceName: newest?.deviceName ?? uid, bytes: items.reduce((s, r) => s + r.bytes, 0), days, newest: newest?.startedAtMs ?? 0 };
  });
  groups.sort((a, b) => b.newest - a.newest);
  return groups.map(({ newest: _n, ...g }) => g);
}

export function totalBytes(recordings: readonly RecordingSummary[]): number {
  return recordings.reduce((sum, r) => sum + r.bytes, 0);
}

/** The recording ids of the devices currently recording (for the top bar's global indicator). */
export function activeRecordingCount(devices: readonly { recording: { enabled: boolean } }[]): number {
  return devices.filter((d) => d.recording.enabled).length;
}
