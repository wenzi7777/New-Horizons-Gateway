// An in-memory HostNative (as NH Pocket's modules/nh-gateway-native behaves): the file API on a
// Map, the `.nhraw` capture writing the same bytes RawCapture.kt does
// (header, records, max(stamp, last) ordering), and datagram injection.
import { bytesToBase64 } from '@nhgw/core';
import { encodeNhrawHeader, encodeNhrawRecord, NhrawSource, type NhrawSourceName } from '@nhgw/engine';

import type { DatagramEvent, HostNative, NativeFileInfo } from '../src/nativeApi';

const SOURCE_NAMES: Record<number, NhrawSourceName> = { 0: 'stream', 1: 'control', 2: 'event' };

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export class FakeNative implements HostNative {
  /** path -> bytes (text files as UTF-8). */
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>(['']);
  readonly mtimes = new Map<string, number>();
  readonly sent: { localPort: number; ip: string; port: number; data: string }[] = [];
  nowUs = Date.UTC(2026, 10, 10, 3, 0, 0) * 1000;
  free = 5e9;
  running = false;
  interfaces = [{ name: 'wlan0', address: '192.168.1.20' }];
  zips: { path: string; zipName: string; skip: string }[] = [];
  private mtimeCounter = 1;
  private handles = new Map<number, { path: string; pending: string }>();
  private raws = new Map<number, { uid: string; path: string; lastUs: number }>();
  private nextHandle = 1;
  private listeners: ((event: DatagramEvent) => void)[] = [];
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  // -- service / UDP --------------------------------------------------------------
  startService() {
    this.running = true;
    return true;
  }
  stopService() {
    this.running = false;
    return true;
  }
  isRunning() {
    return this.running;
  }
  send(localPort: number, ip: string, port: number, data: string) {
    this.sent.push({ localPort, ip, port, data });
  }
  nowEpochUs() {
    return this.nowUs;
  }
  stats() {
    return { running: this.running, datagramsIn: 0, datagramsOut: 0, timeRequests: 0, sendErrors: 0, lastError: '' };
  }
  networkInterfaces() {
    return this.interfaces;
  }
  isIgnoringBatteryOptimizations() {
    return true;
  }
  requestIgnoreBatteryOptimizations() {
    return true;
  }
  addListener(event: 'onDatagram' | 'onTimeServed', listener: (event: never) => void) {
    if (event !== 'onDatagram') return { remove() {} };
    const fn = listener as unknown as (event: DatagramEvent) => void;
    this.listeners.push(fn);
    return {
      remove: () => {
        this.listeners = this.listeners.filter((item) => item !== fn);
      },
    };
  }

  /** A datagram arriving: captured first (as UdpHub does), then handed to JS. */
  receive(localPort: number, data: Uint8Array, from = { ip: '192.168.1.50', port: 4210 }, rxEpochUs = this.nowUs): void {
    if (localPort === 13250 && data.length >= 10 && data[0] === 0x5a && data[1] === 0xa5) {
      const uid = Array.from(data.subarray(4, 10), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
      for (const raw of this.raws.values()) if (raw.uid === uid) this.rawWrite(raw, Math.max(rxEpochUs, raw.lastUs), 0, data);
    }
    const event: DatagramEvent = { localPort, ip: from.ip, srcPort: from.port, data: bytesToBase64(data), rxEpochUs };
    for (const listener of [...this.listeners]) listener(event);
  }

  // -- files ----------------------------------------------------------------------
  private touch(path: string) {
    this.mtimes.set(path, this.mtimeCounter++);
    let dir = path.slice(0, Math.max(0, path.lastIndexOf('/')));
    for (;;) {
      this.dirs.add(dir);
      if (!dir) break;
      dir = dir.slice(0, Math.max(0, dir.lastIndexOf('/')));
    }
  }
  text(path: string): string | null {
    const bytes = this.files.get(path);
    return bytes === undefined ? null : this.decoder.decode(bytes);
  }
  fileExists(path: string) {
    return this.files.has(path) || this.dirs.has(path);
  }
  mkdirp(path: string) {
    this.touch(`${path}/x`);
  }
  fileSize(path: string) {
    return this.files.get(path)?.length ?? -1;
  }
  fileOpen(path: string) {
    if (!this.files.has(path)) {
      this.files.set(path, new Uint8Array(0));
      this.touch(path);
    }
    const handle = this.nextHandle++;
    this.handles.set(handle, { path, pending: '' });
    return handle;
  }
  fileAppend(handle: number, text: string) {
    const file = this.handles.get(handle);
    if (!file) throw new Error('I/O operation on closed file.');
    file.pending += text;
  }
  fileFlush(handle: number) {
    const file = this.handles.get(handle);
    if (!file) throw new Error('I/O operation on closed file.');
    if (file.pending) {
      this.files.set(file.path, concat(this.files.get(file.path) ?? new Uint8Array(0), this.encoder.encode(file.pending)));
      this.touch(file.path);
    }
    file.pending = '';
  }
  fileClose(handle: number) {
    if (!this.handles.has(handle)) return;
    this.fileFlush(handle);
    this.handles.delete(handle);
  }
  writeAtomic(path: string, text: string) {
    this.files.set(path, this.encoder.encode(text));
    this.touch(path);
  }
  readText(path: string) {
    return this.text(path);
  }
  readBytes(path: string, offset: number, length: number) {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error(`no such file: ${path}`);
    return bytes.slice(offset, offset + length);
  }
  stat(path: string): NativeFileInfo | null {
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (this.files.has(path)) return { name, isDirectory: false, size: this.files.get(path)!.length, mtimeMs: this.mtimes.get(path) ?? 0 };
    if (this.dirs.has(path)) return { name, isDirectory: true, size: 0, mtimeMs: 0 };
    return null;
  }
  listDir(path: string): NativeFileInfo[] {
    if (!this.dirs.has(path)) throw new Error(`no such directory: ${path}`);
    const prefix = path ? `${path}/` : '';
    const names = new Set<string>();
    for (const key of [...this.files.keys(), ...this.dirs]) {
      if (key.startsWith(prefix) && key.length > prefix.length) names.add(key.slice(prefix.length).split('/')[0]!);
    }
    return [...names].sort().map((name) => this.stat(prefix + name)!);
  }
  deletePath(path: string) {
    let found = false;
    for (const key of [...this.files.keys()]) if (key === path || key.startsWith(`${path}/`)) found = this.files.delete(key) || found;
    for (const key of [...this.dirs]) if (key === path || key.startsWith(`${path}/`)) found = this.dirs.delete(key) || found;
    return found;
  }
  movePath(from: string, to: string) {
    const bytes = this.files.get(from);
    if (!bytes) return false;
    this.files.delete(from);
    this.files.set(to, bytes);
    this.touch(to);
    return true;
  }
  treeSize(path: string) {
    let total = 0;
    for (const [key, bytes] of this.files) if (key.startsWith(`${path}/`)) total += bytes.length;
    return total;
  }
  freeBytes() {
    return this.free;
  }
  async zipDir(path: string, zipName: string, skip: string) {
    this.zips.push({ path, zipName, skip });
    return `/cache/export/${zipName}`;
  }

  // -- raw capture --------------------------------------------------------------------
  private rawWrite(raw: { path: string; lastUs: number }, stamp: number, source: number, payload: Uint8Array) {
    const record = encodeNhrawRecord({ rxEpochUs: stamp, source: SOURCE_NAMES[source]!, payload });
    this.files.set(raw.path, concat(this.files.get(raw.path) ?? new Uint8Array(0), record));
    raw.lastUs = stamp;
  }
  rawStart(uid: string, path: string, startEpochUs: number, firstEvent: Uint8Array | null) {
    for (const raw of this.raws.values()) if (raw.uid === uid.toUpperCase()) throw new Error('capture_already_running');
    this.files.set(path, encodeNhrawHeader({ deviceUid: uid, startEpochUs }));
    this.touch(path);
    const raw = { uid: uid.toUpperCase(), path, lastUs: startEpochUs };
    if (firstEvent) this.rawWrite(raw, startEpochUs, NhrawSource.event, firstEvent);
    const handle = this.nextHandle++;
    this.raws.set(handle, raw);
    return handle;
  }
  rawAppend(handle: number, source: number, payload: Uint8Array) {
    const raw = this.raws.get(handle);
    if (!raw) throw new Error('capture_closed');
    const stamp = Math.max(this.nowUs, raw.lastUs);
    this.rawWrite(raw, stamp, source, payload);
    return stamp;
  }
  rawFlush() {}
  rawFlushAll() {}
  rawStop(handle: number) {
    this.raws.delete(handle);
  }
  rawStats(handle: number) {
    const raw = this.raws.get(handle);
    return raw ? { uid: raw.uid, path: raw.path, records: 0, bytes: this.files.get(raw.path)?.length ?? 0, lastEpochUs: raw.lastUs, error: '' } : null;
  }
  activeCaptures(): string[] {
    return [...this.raws.values()].map((raw) => raw.path);
  }
  /** JS stops listening (a frozen or dying JS thread); native keeps capturing. */
  detachJs(): void {
    this.listeners = [];
  }

  /** What a killed process leaves: captures and open files just stop. */
  kill(): void {
    for (const handle of [...this.handles.keys()]) this.fileFlush(handle);
    this.handles.clear();
    this.raws.clear();
    this.listeners = [];
  }
}
