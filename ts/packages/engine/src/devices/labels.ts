// What the operator calls a device: nicknames and groups (device_labels.py).
// Python kept them in two JSON files beside the recordings
// (_newhorizons_device_nicknames.json / _newhorizons_device_groups.json);
// the host injects one JsonStore per file, so Studio can point them at the
// same files the Desktop writes.
import type { JsonStore } from '@nhgw/core';

import { isDict, pyStr, sortedKeys } from './py';

export type StringMap = Record<string, string>;

export const LABEL_MAX_LENGTH = 64;

/** `_load_string_map`: non-dicts become {}; keys and values stringified and stripped, blanks dropped. */
export function cleanStringMap(data: unknown): StringMap {
  if (!isDict(data)) return {};
  const out: StringMap = {};
  for (const [key, value] of Object.entries(data)) {
    const k = pyStr(key);
    const v = pyStr(value).trim();
    if (k.trim() && v) out[k] = v;
  }
  return out;
}

/** What `_save_string_map` wrote: keys sorted. */
export function sortedStringMap(values: ReadonlyMap<string, string>): StringMap {
  const obj: StringMap = Object.fromEntries(values);
  const out: StringMap = {};
  for (const key of sortedKeys(obj)) out[key] = obj[key]!;
  return out;
}

export class LabelError extends Error {
  constructor(readonly code: 'nickname_too_long' | 'device_group_too_long') {
    super(code);
    this.name = 'LabelError';
  }
}

export interface DeviceLabelsOptions {
  nicknames?: JsonStore<StringMap> | null;
  groups?: JsonStore<StringMap> | null;
}

export class DeviceLabels {
  private readonly nicknames = new Map<string, string>();
  private readonly groups = new Map<string, string>();
  private readonly nicknameStore: JsonStore<StringMap> | null;
  private readonly groupStore: JsonStore<StringMap> | null;

  constructor(options: DeviceLabelsOptions = {}) {
    this.nicknameStore = options.nicknames ?? null;
    this.groupStore = options.groups ?? null;
  }

  /** Loads both maps; an unreadable store counts as empty, as in Python. */
  async load(): Promise<void> {
    for (const [store, target] of [
      [this.nicknameStore, this.nicknames],
      [this.groupStore, this.groups],
    ] as const) {
      target.clear();
      if (store === null) continue;
      let data: unknown = null;
      try {
        data = await store.load();
      } catch {
        data = null;
      }
      for (const [key, value] of Object.entries(cleanStringMap(data))) target.set(key, value);
    }
  }

  nickname(deviceUid: string): string {
    return this.nicknames.get(deviceUid) ?? '';
  }

  group(deviceUid: string): string {
    return this.groups.get(deviceUid) ?? '';
  }

  allNicknames(): StringMap {
    return sortedStringMap(this.nicknames);
  }

  allGroups(): StringMap {
    return sortedStringMap(this.groups);
  }

  /** Sets (or, when blank, clears) and persists. Throws LabelError('nickname_too_long'). Returns the stripped value. */
  async setNickname(deviceUid: string, nickname: unknown): Promise<string> {
    const value = cleanLabel(nickname);
    if ([...value].length > LABEL_MAX_LENGTH) throw new LabelError('nickname_too_long');
    if (value) this.nicknames.set(deviceUid, value);
    else this.nicknames.delete(deviceUid);
    await this.nicknameStore?.save(sortedStringMap(this.nicknames));
    return value;
  }

  /** Throws LabelError('device_group_too_long'). */
  async setGroup(deviceUid: string, group: unknown): Promise<string> {
    const value = cleanLabel(group);
    if ([...value].length > LABEL_MAX_LENGTH) throw new LabelError('device_group_too_long');
    if (value) this.groups.set(deviceUid, value);
    else this.groups.delete(deviceUid);
    await this.groupStore?.save(sortedStringMap(this.groups));
    return value;
  }
}

/** `str(value or "").strip()`. */
function cleanLabel(value: unknown): string {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return '';
  return pyStr(value).trim();
}
