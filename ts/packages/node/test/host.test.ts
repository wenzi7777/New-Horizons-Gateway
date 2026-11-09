// The host for real: dgram sockets and the HTTP server on 127.0.0.1 with
// ephemeral ports, a fake upstream WebSocket, files in a temp dir.
import { createSocket, type Socket } from 'node:dgram';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { base64ToBytes } from '@nhgw/core';

import { PortInUseError } from '../src/adapters/udp';
import { runGateway, type NodeGatewayHost } from '../src/host';
import { resolveRuntimePaths } from '../src/paths';
import { FakeConnector, offlineHttp, tempDir, waitFor } from './helpers';

const UID = '3CDC7545CCD0';

function v5Packet(uid = UID, payloadLen = 8): Uint8Array {
  const packet = new Uint8Array(24 + payloadLen);
  const view = new DataView(packet.buffer);
  view.setUint16(0, 0xa55a, true);
  packet[2] = 5;
  for (let i = 0; i < 6; i++) packet[4 + i] = parseInt(uid.slice(i * 2, i * 2 + 2), 16);
  view.setUint32(10, 1, true);
  view.setUint16(22, payloadLen, true);
  return packet;
}

function timeRequest(seq: number, t1: bigint): Uint8Array {
  const out = new Uint8Array(12);
  out[0] = 0xe8;
  out[1] = 1;
  out[2] = seq;
  new DataView(out.buffer).setBigInt64(4, t1, true);
  return out;
}

const LOCAL = {
  listen_udp_host: '127.0.0.1',
  listen_udp_port: 0,
  listen_discovery_host: '127.0.0.1',
  listen_discovery_port: 0,
  listen_web_host: '127.0.0.1',
  listen_web_port: 0,
  target_mode: 'local',
};

interface Started {
  host: NodeGatewayHost;
  connector: FakeConnector;
  root: string;
  base: string;
}

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups = [];
});

async function start(config: Record<string, unknown> = {}): Promise<Started> {
  const t = tempDir();
  const paths = resolveRuntimePaths({ root: t.dir, env: {} });
  mkdirSync(join(t.dir, '.run', 'config'), { recursive: true });
  writeFileSync(paths.configFile, JSON.stringify({ ...LOCAL, ...config }));
  const connector = new FakeConnector();
  const host = await runGateway({ paths, env: {}, cwd: t.dir, connector, http: offlineHttp, handleSignals: false, tickIntervalMs: 50 });
  cleanups.push(async () => {
    await host.stop();
    t.cleanup();
  });
  return { host, connector, root: t.dir, base: `http://127.0.0.1:${host.webPort}` };
}

async function udpClient(): Promise<{ socket: Socket; next: () => Promise<Buffer> }> {
  const socket = createSocket('udp4');
  const queue: Buffer[] = [];
  const waiters: ((b: Buffer) => void)[] = [];
  socket.on('message', (msg) => {
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });
  await new Promise<void>((r) => socket.bind(0, '127.0.0.1', () => r()));
  cleanups.push(() => new Promise<void>((r) => socket.close(() => r())));
  const next = () =>
    new Promise<Buffer>((resolve, reject) => {
      const queued = queue.shift();
      if (queued) return resolve(queued);
      const timer = setTimeout(() => reject(new Error('no reply')), 2000);
      waiters.push((b) => {
        clearTimeout(timer);
        resolve(b);
      });
    });
  return { socket, next };
}

function send(socket: Socket, data: Uint8Array | string, port: number): Promise<void> {
  return new Promise((r, j) => socket.send(typeof data === 'string' ? Buffer.from(data) : data, port, '127.0.0.1', (e) => (e ? j(e) : r())));
}

async function api(base: string, path: string, body?: unknown, init: RequestInit = {}) {
  const response = await fetch(base + path, {
    method: body === undefined && !init.method ? 'GET' : (init.method ?? 'POST'),
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...init,
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // html
  }
  return { status: response.status, json, text, headers: response.headers };
}

describe('UDP on real sockets', () => {
  it('answers FindMe, time requests, and forwards the stream upstream', async () => {
    const { host, connector } = await start({ enabled: true, gateway_id: 'nh-gateway-test' });
    const udpPort = host.udpPort()!;
    const findmePort = host.discoveryPort()!;
    expect(udpPort).toBeGreaterThan(0);
    expect(findmePort).toBeGreaterThan(0);
    await waitFor(() => connector.connections.length > 0 && connector.last.ofType('hello').length > 0);
    expect(connector.last.url).toBe('ws://127.0.0.1:5051/newhorizons/gateway/ws');
    expect(connector.last.ofType('hello')[0]).toMatchObject({ gateway_id: 'nh-gateway-test', client_type: 'gateway', version: host.version });

    const device = await udpClient();
    await send(device.socket, JSON.stringify({ type: 'findme_discover', device_uid: UID, mode: 'normal' }), findmePort);
    const offer = JSON.parse((await device.next()).toString('utf8'));
    expect(offer).toMatchObject({ type: 'findme_offer', gateway_id: 'nh-gateway-test', accept: true, udp_port: udpPort, device_uid: UID });

    const t1 = BigInt(Date.now()) * 1000n;
    await send(device.socket, timeRequest(7, t1), udpPort);
    const reply = await device.next();
    expect(reply.length).toBe(32);
    expect(reply[0]).toBe(0xe9);
    expect(reply[2]).toBe(7);
    const view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
    const t2 = view.getBigInt64(12, true);
    const t3 = view.getBigInt64(20, true);
    expect(view.getBigInt64(4, true)).toBe(t1);
    expect(t3 >= t2).toBe(true);
    expect(Number(t2 - t1)).toBeLessThan(5_000_000);

    const packet = v5Packet();
    await send(device.socket, packet, udpPort);
    await waitFor(() => connector.last.packets().length === 1);
    expect(Buffer.from(base64ToBytes(connector.last.packets()[0]!.slice('NHPKT1:'.length)))).toEqual(Buffer.from(packet));
    // Time requests never go upstream.
    expect(connector.last.packets()).toHaveLength(1);
    expect(host.stats()).toMatchObject({ devices: 1, serving: 1 });
  });

  it('binds nothing while disabled and releases the ports on stop', async () => {
    const { host } = await start({ enabled: false });
    expect(host.udpPort()).toBeNull();
    expect(host.discoveryPort()).toBeNull();
    const webPort = host.webPort;
    await host.stop();
    await expect(host.done).resolves.toBe('exit');
    // The web port is free again.
    const server = createServer();
    await new Promise<void>((r, j) => server.once('error', j).listen(webPort, '127.0.0.1', () => r()));
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe('files', () => {
  it('writes pid, health and console status, and removes pid/health on stop', async () => {
    const { host } = await start({ enabled: true, gateway_id: 'gw-files' });
    const paths = host.paths;
    expect(readFileSync(paths.pidFile, 'utf8')).toBe(String(process.pid));
    const health = JSON.parse(readFileSync(paths.healthFile, 'utf8'));
    expect(health).toMatchObject({ pid: process.pid, version: host.version, web_port: host.webPort, ready: true });
    const status = JSON.parse(readFileSync(join(paths.runDir, 'console-status.json'), 'utf8'));
    expect(status).toMatchObject({
      enabled: true,
      gateway_id: 'gw-files',
      target_mode: 'local',
      web_ui_url: `http://127.0.0.1:${host.webPort}`,
      listen_udp_port: host.udpPort(),
      current_version: host.version,
    });
    expect(host.status()).toMatchObject({ gateway_id: 'gw-files' });
    expect(host.recentLogs().some((line) => line.message.includes('New Horizons Gateway'))).toBe(true);
    expect(readFileSync(paths.logFile, 'utf8')).toContain('New Horizons Gateway');
    await host.stop();
    expect(existsSync(paths.pidFile)).toBe(false);
    expect(existsSync(paths.healthFile)).toBe(false);
  });

  it('restart via the web API ends the run with "restart"', async () => {
    const { host, base } = await start({ enabled: false });
    const { status, json } = await api(base, '/api/update/restart', {});
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    await expect(host.done).resolves.toBe('restart');
  });
});

describe('port conflicts', () => {
  async function holdUdp(): Promise<{ port: number; close: () => Promise<void> }> {
    const socket = createSocket({ type: 'udp4', reuseAddr: false });
    await new Promise<void>((r) => socket.bind(0, '127.0.0.1', () => r()));
    return { port: socket.address().port, close: () => new Promise((r) => socket.close(() => r())) };
  }

  it('says which UDP port is taken and what it is for', async () => {
    const held = await holdUdp();
    cleanups.push(held.close);
    const t = tempDir();
    cleanups.push(t.cleanup);
    const paths = resolveRuntimePaths({ root: t.dir, env: {} });
    mkdirSync(join(t.dir, '.run', 'config'), { recursive: true });
    writeFileSync(paths.configFile, JSON.stringify({ ...LOCAL, enabled: true, gateway_id: 'gw-x', listen_udp_port: held.port }));
    const error = await runGateway({ paths, env: {}, connector: new FakeConnector(), http: offlineHttp, handleSignals: false }).catch((e) => e);
    expect(error).toBeInstanceOf(PortInUseError);
    expect(error.message).toContain(`UDP port ${held.port}`);
    expect(error.message).toContain('device stream/control');
    expect(error.message).toContain('listen_udp_port');
    expect(error.message).toContain(paths.configFile);
    expect(error.message).toContain('already in use');
    expect(readFileSync(paths.logFile, 'utf8')).toContain(`UDP port ${held.port}`);
  });

  it('says so for the FindMe port and the web port', async () => {
    const held = await holdUdp();
    cleanups.push(held.close);
    const t = tempDir();
    cleanups.push(t.cleanup);
    const paths = resolveRuntimePaths({ root: t.dir, env: {} });
    mkdirSync(join(t.dir, '.run', 'config'), { recursive: true });
    writeFileSync(paths.configFile, JSON.stringify({ ...LOCAL, enabled: true, gateway_id: 'gw-x', listen_discovery_port: held.port }));
    const findme = await runGateway({ paths, env: {}, connector: new FakeConnector(), http: offlineHttp, handleSignals: false }).catch((e) => e);
    expect(findme).toBeInstanceOf(PortInUseError);
    expect(findme.message).toContain(`UDP port ${held.port}`);
    expect(findme.message).toContain('FindMe');

    const tcp: Server = createServer();
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => new Promise<void>((r) => tcp.close(() => r())));
    const webPort = (tcp.address() as { port: number }).port;
    writeFileSync(paths.configFile, JSON.stringify({ ...LOCAL, listen_web_port: webPort }));
    const web = await runGateway({ paths, env: {}, connector: new FakeConnector(), http: offlineHttp, handleSignals: false }).catch((e) => e);
    expect(web).toBeInstanceOf(PortInUseError);
    expect(web.message).toContain(`TCP port ${webPort}`);
    expect(web.message).toContain('web UI');
    expect(web.message).toContain('listen_web_port');
  });
});

describe('web API', () => {
  it('serves the page and assets like web.py', async () => {
    const { base, host } = await start();
    const page = await api(base, '/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('cache-control')).toBe('no-cache');
    expect(page.text).not.toContain('__VERSION__');
    expect(page.text).toContain(`/assets/app.css?v=${host.version}`);
    expect(page.text.indexOf('/assets/tokens.css')).toBeLessThan(page.text.indexOf('/assets/app.css'));

    const app = await api(base, '/assets/app.js');
    expect(app.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(app.text).toContain('wss://isensing-s1.u-aizu.ac.jp/newhorizons/gateway/ws');
    expect(app.text).not.toContain('__LOCAL_URL__');

    const tokens = await api(base, '/assets/tokens.css');
    expect(tokens.status).toBe(200);
    expect(tokens.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(tokens.text).toContain('--accent: #1f6b54;');

    expect((await api(base, '/assets/nope.js')).status).toBe(404);
    expect((await api(base, '/assets/index.html')).status).toBe(404);
    expect((await api(base, '/assets/..%2Fpackage.json')).status).toBe(404);
    expect((await api(base, '/nope')).status).toBe(404);
    const wrongMethod = await api(base, '/api/status', {});
    expect(wrongMethod.status).toBe(405);
    expect((await api(base, '/api/settings')).status).toBe(405);
  });

  it('/api/status has web.py fields', async () => {
    const { base, host } = await start({ gateway_id: 'gw-status' });
    const { status, json, headers } = await api(base, '/api/status');
    expect(status).toBe(200);
    expect(headers.get('content-type')).toBe('application/json');
    expect(Object.keys(json).sort()).toEqual(['config', 'legacy_import', 'state', 'udp_control', 'update_state', 'upstream', 'version']);
    expect(json.version).toBe(host.version);
    expect(json.config).toMatchObject({ gateway_id: 'gw-status', enabled: false, target_mode: 'local', listen_web_port: 0 });
    expect(json.state).toMatchObject({ devices: [], nearby_devices: [], denied_devices: [], claims: [], findme_requests: [] });
    expect(json.upstream).toHaveProperty('connected');
    expect(json.update_state).toMatchObject({ current_version: host.version, required_update: false });
    expect(json.legacy_import).toBeNull();
  });

  it('saves settings, with web.py validation errors and status codes', async () => {
    const { base, host, connector } = await start();
    let r = await api(base, '/api/settings', { enabled: true, gateway_id: '' });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ ok: false, error: 'gateway_id_required' });
    r = await api(base, '/api/settings', { enabled: true, gateway_id: 'bad id!' });
    expect(r).toMatchObject({ status: 400, json: { ok: false, error: 'gateway_id_invalid' } });
    r = await api(base, '/api/settings', { target_mode: 'nowhere', gateway_id: 'gw-1' });
    expect(r).toMatchObject({ status: 400, json: { ok: false, error: 'invalid_target_mode' } });

    r = await api(base, '/api/settings', { enabled: true, gateway_id: 'gw-saved', target_mode: 'local' });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.config).toMatchObject({ enabled: true, gateway_id: 'gw-saved', server_url: 'ws://127.0.0.1:5051/newhorizons/gateway/ws' });
    // Enabling binds the sockets and connects upstream.
    await waitFor(() => host.udpPort() !== null && connector.connections.length > 0);
    const onDisk = JSON.parse(readFileSync(host.paths.configFile, 'utf8'));
    expect(onDisk).toMatchObject({ enabled: true, gateway_id: 'gw-saved' });
    expect(readFileSync(host.paths.configFile, 'utf8')).toContain('"control_stale_sec": 16.0');

    // Missing JSON content type: Flask's get_json(silent=True) -> {}, i.e. disable with an empty id.
    r = await api(base, '/api/settings', undefined, { method: 'POST', body: '{"enabled": true}', headers: { 'Content-Type': 'text/plain' } });
    expect(r.status).toBe(200);
    expect(r.json.config).toMatchObject({ enabled: false, gateway_id: '', target_mode: 'production' });
    await waitFor(() => host.udpPort() === null);

    const suggest = await api(base, '/api/gateway-id/suggest', {});
    expect(suggest.status).toBe(200);
    expect(suggest.json.gateway_id).toMatch(/^nh-gateway-[0-9a-f]{6}$/);
  });

  it('rejects and allows devices, and serve needs the server', async () => {
    const { base, host } = await start({ gateway_id: 'gw-dev' });
    let r = await api(base, '/api/devices/aabbccddeeff/reject', {});
    expect(r).toMatchObject({ status: 200, json: { ok: true, denied_devices: ['AABBCCDDEEFF'] } });
    expect((await api(base, '/api/status')).json.state.denied_devices).toEqual(['AABBCCDDEEFF']);
    expect(JSON.parse(readFileSync(host.paths.configFile, 'utf8')).denied_devices).toEqual(['AABBCCDDEEFF']);
    r = await api(base, '/api/devices/AABBCCDDEEFF/serve', {});
    expect(r).toMatchObject({ status: 409, json: { ok: false, error: 'device_denied' } });
    r = await api(base, '/api/devices/AABBCCDDEEFF/allow', {});
    expect(r).toMatchObject({ status: 200, json: { ok: true, denied_devices: [] } });
    r = await api(base, '/api/devices/AABBCCDDEEFF/serve', {});
    expect(r).toMatchObject({ status: 503, json: { ok: false, error: 'upstream_offline' } });
    expect((await api(base, '/api/discover', {})).json).toEqual({ ok: true });
  });

  it('update endpoints answer with update_state; channel validates', async () => {
    const { base } = await start({ gateway_id: 'gw-up' });
    const check = await api(base, '/api/update/check', {});
    expect(check.status).toBe(200);
    expect(check.json.ok).toBe(true);
    expect(check.json.update_state).toMatchObject({ phase: 'error', last_error: 'offline' });
    let r = await api(base, '/api/update/channel', { channel: 'nightly' });
    expect(r).toMatchObject({ status: 400, json: { ok: false, error: 'invalid_update_channel' } });
    r = await api(base, '/api/update/channel', { channel: 'beta' });
    expect(r.status).toBe(200);
    expect(r.json.config.update_channel).toBe('beta');
    expect(r.json.update_state.update_channel).toBe('beta');
    for (const path of ['/api/update/start', '/api/update/download', '/api/update/apply']) {
      const started = await api(base, path, {});
      expect(started.status).toBe(200);
      expect(started.json.ok).toBe(true);
      expect(started.json).toHaveProperty('update_state');
    }
  });

  it('reports a legacy import in /api/status and the console status', async () => {
    const t = tempDir();
    const paths = resolveRuntimePaths({ root: t.dir, env: {} });
    writeFileSync(join(t.dir, 'gateway_config.json'), JSON.stringify({ ...LOCAL, gateway_id: 'nh-gateway-old' }));
    const host = await runGateway({ paths, env: {}, cwd: t.dir, connector: new FakeConnector(), http: offlineHttp, handleSignals: false });
    cleanups.push(async () => {
      await host.stop();
      t.cleanup();
    });
    expect(host.legacyImportedNow).toBe(true);
    const json = (await api(`http://127.0.0.1:${host.webPort}`, '/api/status')).json;
    expect(json.config.gateway_id).toBe('nh-gateway-old');
    expect(json.legacy_import).toMatchObject({ source: join(t.dir, 'gateway_config.json'), in_place: false, gateway_id: 'nh-gateway-old' });
    expect(host.status().legacy_import).toMatchObject({ gateway_id: 'nh-gateway-old' });
  });
});
