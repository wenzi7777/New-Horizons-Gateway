import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { NodeClock } from '../src/adapters/clock';
import { HostLogger } from '../src/adapters/logger';
import { NodeWsConnector } from '../src/adapters/ws';
import { tempDir } from './helpers';

class FakeWebSocket extends EventTarget {
  static last: FakeWebSocket | null = null;
  readyState = 0;
  bufferedAmount = 0;
  binaryType = 'blob';
  sent: string[] = [];
  closed = false;
  constructor(
    readonly url: string,
    readonly init?: unknown,
  ) {
    super();
    FakeWebSocket.last = this;
  }
  send(text: string) {
    this.sent.push(text);
  }
  close() {
    this.closed = true;
  }
}

describe('NodeWsConnector', () => {
  it('maps WebSocket events and exposes bufferedAmount', () => {
    const events: string[] = [];
    const logger = new HostLogger();
    const connector = new NodeWsConnector({ WebSocketImpl: FakeWebSocket as never, logger });
    const conn = connector.connect('ws://x/ws', {}, {
      onOpen: () => events.push('open'),
      onMessage: (data) => events.push(typeof data === 'string' ? `text:${data}` : `bytes:${Array.from(data).join(',')}`),
      onClose: (reason) => events.push(`close:${reason}`),
      onError: (message) => events.push(`error:${message}`),
    });
    const ws = FakeWebSocket.last!;
    expect(ws.init).toBeUndefined();
    expect(ws.binaryType).toBe('arraybuffer');
    expect(() => conn.send('early')).toThrow('websocket_not_open');
    ws.readyState = 1;
    ws.dispatchEvent(new Event('open'));
    conn.send('hello');
    expect(ws.sent).toEqual(['hello']);
    ws.dispatchEvent(new MessageEvent('message', { data: 'hi' }));
    ws.dispatchEvent(new MessageEvent('message', { data: new Uint8Array([1, 2]).buffer }));
    ws.bufferedAmount = 4096;
    expect(conn.bufferedAmount).toBe(4096);
    ws.dispatchEvent(Object.assign(new Event('error'), { message: 'boom' }));
    ws.dispatchEvent(Object.assign(new Event('close'), { code: 1006, reason: '' }));
    expect(events).toEqual(['open', 'text:hi', 'bytes:1,2', 'error:boom', 'close:connection closed (1006)']);
    conn.close();
    expect(ws.closed).toBe(true);
  });

  it('passes headers through the init object and says so once', () => {
    const logger = new HostLogger();
    const connector = new NodeWsConnector({ WebSocketImpl: FakeWebSocket as never, logger });
    const handlers = { onOpen() {}, onMessage() {}, onClose() {}, onError() {} };
    connector.connect('ws://x/ws', { Authorization: 'Bearer t' }, handlers);
    expect(FakeWebSocket.last!.init).toEqual({ headers: { Authorization: 'Bearer t' } });
    connector.connect('ws://x/ws', { Authorization: 'Bearer t' }, handlers);
    expect(logger.recent().filter((l) => l.level === 'warn')).toHaveLength(1);
  });
});

describe('HostLogger', () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it('appends to the log file and keeps a bounded ring', () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const file = join(t.dir, 'logs', 'gateway.log');
    const logger = new HostLogger({ file, ringSize: 3 });
    const seen: string[] = [];
    const off = logger.onLine((line) => seen.push(line.message));
    for (const n of [1, 2, 3, 4]) logger.info(`line ${n}`);
    logger.error('bad');
    off();
    logger.warn('unseen');
    expect(logger.recent().map((l) => l.message)).toEqual(['line 4', 'bad', 'unseen']);
    expect(seen).toEqual(['line 1', 'line 2', 'line 3', 'line 4', 'bad']);
    const text = readFileSync(file, 'utf8').trim().split('\n');
    expect(text).toHaveLength(6);
    expect(text[4]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} ERROR bad$/);
  });
});

describe('NodeClock', () => {
  it('gives µs wall time close to Date.now and a monotonic ms clock', () => {
    const clock = new NodeClock();
    expect(Math.abs(clock.nowEpochUs() / 1000 - Date.now())).toBeLessThan(60);
    const a = clock.monotonicMs();
    expect(clock.monotonicMs()).toBeGreaterThanOrEqual(a);
  });
});
