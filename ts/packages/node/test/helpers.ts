// Shared by the host tests: temp dirs, a fake upstream WebSocket, a fake HTTP.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Http, WsConnection, WsConnector, WsHandlers } from '@nhgw/core';

export function tempDir(prefix = 'nhgw-node-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export class FakeWs implements WsConnection {
  sent: string[] = [];
  closed = false;
  bufferedAmount = 0;
  constructor(
    readonly url: string,
    readonly handlers: WsHandlers,
  ) {}
  send(text: string) {
    this.sent.push(text);
  }
  close() {
    this.closed = true;
  }
  ofType(type: string): Record<string, any>[] {
    return this.sent.filter((s) => s.startsWith('{')).map((s) => JSON.parse(s)).filter((m) => m.type === type);
  }
  packets(): string[] {
    return this.sent.filter((s) => s.startsWith('NHPKT1:'));
  }
}

/** Opens every connection at once, as if the Backend answered. */
export class FakeConnector implements WsConnector {
  connections: FakeWs[] = [];
  constructor(private readonly autoOpen = true) {}
  /** The request headers of each connection, in order. */
  headers: Record<string, string>[] = [];
  connect(url: string, headers: Record<string, string>, handlers: WsHandlers): WsConnection {
    const ws = new FakeWs(url, handlers);
    this.connections.push(ws);
    this.headers.push({ ...headers });
    if (this.autoOpen) queueMicrotask(() => handlers.onOpen());
    return ws;
  }
  get last(): FakeWs {
    return this.connections.at(-1)!;
  }
}

/** No network in tests: every request fails like an unreachable host. */
export const offlineHttp: Http = {
  async getText() {
    throw new Error('offline');
  },
  async getBytes() {
    throw new Error('offline');
  },
};

export async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}
