// The local web UI and its API (web.py), on node:http. Routes, status codes
// and JSON shapes are web.py's; the web UI (webui/app.js) and anything else
// that scripted the Python Gateway keep working unchanged. Every operation
// goes through the core's GatewayOperations, the same ones the Desktop's
// remote commands use.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { LOCAL_URL, PRODUCTION_URL, validateGatewayId, type GatewayRuntime, type Json, type Logger, type OpResult, silentLogger } from '@nhgw/core';

import { PortInUseError } from '../adapters/udp';
import { readAsset, TOKENS_CSS } from '../assets';
import { pyJsonDumps } from '../pyJson';

/** web.py WEBUI_ASSETS, plus the design tokens shared with the Desktop. */
export const WEBUI_ASSET_TYPES: Readonly<Record<string, string>> = Object.freeze({
  'app.css': 'text/css; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'i18n.js': 'text/javascript; charset=utf-8',
  'markdown.js': 'text/javascript; charset=utf-8',
  'select.js': 'text/javascript; charset=utf-8',
  'theme.js': 'text/javascript; charset=utf-8',
  [TOKENS_CSS]: 'text/css; charset=utf-8',
});

/** Request bodies are small JSON objects; anything bigger is refused. */
export const MAX_BODY_BYTES = 1024 * 1024;

export interface GatewayWebServerOptions {
  host: string;
  port: number;
  /** The running Gateway (the host replaces it on an in-process restart, so it is read per request). */
  runtime: () => GatewayRuntime;
  version: string;
  logger?: Logger;
  /** Extra top-level fields for /api/status (e.g. legacy_import). */
  extraStatus?: () => Json;
}

/** web.py render_webui_file: the same placeholders, replaced on every request. */
export function renderWebuiFile(name: string, version: string): Buffer | null {
  const bytes = readAsset(name);
  if (bytes === null) return null;
  if (name === 'index.html') return Buffer.from(bytes.toString('utf8').split('__VERSION__').join(version), 'utf8');
  if (name === 'app.js') {
    return Buffer.from(
      bytes.toString('utf8').split('__PRODUCTION_URL__').join(PRODUCTION_URL).split('__LOCAL_URL__').join(LOCAL_URL),
      'utf8',
    );
  }
  return bytes;
}

/** Flask's jsonify: sorted keys, compact, ASCII-only, trailing newline. */
export function flaskJson(value: unknown): string {
  return `${pyJsonDumps(value, { sortKeys: true, ensureAscii: true })}\n`;
}

/** web.py _public_config: currently the whole config. */
export function publicConfig(config: unknown): Json {
  return { ...(config as Json) };
}

/** Python bool(): what `bool(body.get("enabled", False))` makes of a JSON value. */
function pyBool(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Werkzeug's error pages, so a browser or script sees what Flask sent.
const ERROR_PAGES: Record<number, [string, string]> = {
  404: ['Not Found', 'The requested URL was not found on the server. If you entered the URL manually please check your spelling and try again.'],
  405: ['Method Not Allowed', 'The method is not allowed for the requested URL.'],
  413: ['Request Entity Too Large', 'The data value transmitted exceeds the capacity limit.'],
};

function errorPage(status: number): string {
  const [title, description] = ERROR_PAGES[status] ?? ['Error', ''];
  return `<!doctype html>\n<html lang=en>\n<title>${status} ${title}</title>\n<h1>${title}</h1>\n<p>${description}</p>\n`;
}

type Handler = (body: Json, params: string[]) => Promise<[number, unknown]> | [number, unknown];

interface Route {
  method: 'GET' | 'POST';
  pattern: RegExp;
  json?: Handler;
}

export class GatewayWebServer {
  readonly host: string;
  private readonly requestedPort: number;
  private readonly getRuntime: () => GatewayRuntime;
  private readonly version: string;
  private readonly logger: Logger;
  private readonly extraStatus: () => Json;
  private server: Server | null = null;
  private boundPort: number | null = null;
  private readonly routes: Route[];

  constructor(options: GatewayWebServerOptions) {
    this.host = options.host || '0.0.0.0';
    this.requestedPort = options.port;
    this.getRuntime = options.runtime;
    this.version = options.version;
    this.logger = options.logger ?? silentLogger;
    this.extraStatus = options.extraStatus ?? (() => ({}));
    this.routes = this.buildRoutes();
  }

  /** The port it listens on (the config may say 0), or null while stopped. */
  get port(): number | null {
    return this.boundPort;
  }

  /** Listens; rejects with PortInUseError when the port is taken. Resolves with the bound port. */
  async start(): Promise<number> {
    if (this.server !== null) return this.boundPort!;
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    // The web UI polls every 2 s over keep-alive; close idle sockets promptly on stop().
    server.keepAliveTimeout = 5_000;
    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        reject(new PortInUseError('tcp', this.host, this.requestedPort, 'web UI', 'listen_web_port', String(error.code ?? 'EUNKNOWN')));
      };
      server.once('error', onError);
      server.listen({ host: this.host, port: this.requestedPort, exclusive: true }, () => {
        server.off('error', onError);
        resolvePromise();
      });
    });
    server.on('error', (error) => this.logger.error(`web server: ${error.message}`));
    this.server = server;
    this.boundPort = (server.address() as AddressInfo).port;
    return this.boundPort;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.boundPort = null;
    if (server === null) return;
    await new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
      server.closeIdleConnections();
      // In-flight requests had their chance; long-polling browsers do not hold the port.
      setTimeout(() => server.closeAllConnections(), 250).unref();
    });
  }

  // ── routing ─────────────────────────────────────────────────────────────

  private buildRoutes(): Route[] {
    const post = (path: string, json: Handler): Route => ({ method: 'POST', pattern: new RegExp(`^${path}$`), json });
    const deviceRoute = (action: 'reject' | 'allow' | 'serve'): Route =>
      post(`/api/devices/([^/]+)/${action}`, async (_body, [uid]) => {
        const ops = this.getRuntime().operations();
        if (action === 'reject') return this.reply(await ops.deny(uid));
        if (action === 'allow') return this.reply(await ops.allow(uid));
        return this.reply(ops.serve(uid));
      });
    return [
      { method: 'GET', pattern: /^\/$/ },
      { method: 'GET', pattern: /^\/assets\/([^/]+)$/ },
      { method: 'GET', pattern: /^\/api\/status$/, json: () => this.status() },
      post('/api/settings', (body) => this.saveSettings(body)),
      post('/api/gateway-id/suggest', () => {
        try {
          return [200, { gateway_id: validateGatewayId(`nh-gateway-${randomBytes(3).toString('hex')}`) }];
        } catch (error) {
          return [503, { ok: false, error: errorText(error) }];
        }
      }),
      post('/api/update/check', async () => [200, { ok: true, update_state: await this.updates().check(true) }]),
      post('/api/update/start', async () => [200, { ok: true, update_state: await this.updates().startUpdate() }]),
      post('/api/update/download', async () => [200, { ok: true, update_state: await this.updates().startUpdate() }]),
      post('/api/update/apply', async () => [200, { ok: true, update_state: await this.updates().startUpdate() }]),
      // Deliberately not locked: switching back to stable is how an operator
      // gets out of a beta-required update.
      post('/api/update/channel', async (body) => this.reply(await this.getRuntime().operations().setUpdateChannel(body.channel))),
      post('/api/update/restart', () => [200, { ok: true, update_state: this.updates().restart() }]),
      post('/api/discover', () => this.reply(this.getRuntime().operations().discover())),
      deviceRoute('reject'),
      deviceRoute('allow'),
      deviceRoute('serve'),
    ];
  }

  private updates() {
    return this.getRuntime().updateControl;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      path = '\u0000';
    }
    try {
      const matching = this.routes.filter((route) => route.pattern.test(path));
      if (matching.length === 0) throw new HttpError(404, 'not_found');
      const effective = method === 'HEAD' ? 'GET' : method;
      const route = matching.find((candidate) => candidate.method === effective);
      if (route === undefined) {
        const allowed = new Set<string>(['OPTIONS']);
        for (const candidate of matching) {
          allowed.add(candidate.method);
          if (candidate.method === 'GET') allowed.add('HEAD');
        }
        if (method === 'OPTIONS') {
          res.writeHead(200, { Allow: [...allowed].sort().join(', '), 'Content-Length': '0' });
          res.end();
          return;
        }
        res.setHeader('Allow', [...allowed].sort().join(', '));
        throw new HttpError(405, 'method_not_allowed');
      }
      const params = (route.pattern.exec(path) ?? []).slice(1);
      if (route.json === undefined) {
        if (path === '/') this.sendFile(req, res, 'index.html');
        // web.py served only the WEBUI_ASSETS names here (index.html is not one).
        else if (params[0]! in WEBUI_ASSET_TYPES) this.sendFile(req, res, params[0]!);
        else this.sendError(req, res, 404);
        return;
      }
      const body = route.method === 'POST' ? await readJsonBody(req) : {};
      const [status, payload] = await route.json(body, params);
      this.sendJson(req, res, status, payload);
      if (route.method === 'POST') this.logger.info(`${method} ${path} ${status}`);
    } catch (error) {
      if (error instanceof HttpError) {
        this.sendError(req, res, error.status);
        return;
      }
      this.logger.error(`${method} ${path}: ${errorText(error)}`);
      if (!res.headersSent) this.sendJson(req, res, 500, { ok: false, error: errorText(error) });
      else res.destroy();
    }
  }

  private sendFile(req: IncomingMessage, res: ServerResponse, name: string): void {
    const isIndex = name === 'index.html';
    const type = isIndex ? 'text/html; charset=utf-8' : WEBUI_ASSET_TYPES[name];
    const bytes = type === undefined ? null : renderWebuiFile(name, this.version);
    if (bytes === null || type === undefined) {
      this.sendError(req, res, 404);
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': String(bytes.length), 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  }

  private sendJson(req: IncomingMessage, res: ServerResponse, status: number, payload: unknown): void {
    const body = Buffer.from(flaskJson(payload), 'utf8');
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(body.length) });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  private sendError(req: IncomingMessage, res: ServerResponse, status: number): void {
    const body = Buffer.from(errorPage(status), 'utf8');
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(body.length) });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  // ── handlers ────────────────────────────────────────────────────────────

  /** web.py reply(): {ok:false,error} with the op's status, or {ok:true,...data} with the config made public. */
  private reply(result: OpResult): [number, unknown] {
    if (!result.ok) return [result.status, { ok: false, error: result.error }];
    const body: Json = { ok: true, ...result.data };
    if ('config' in body) body.config = publicConfig(body.config);
    return [200, body];
  }

  private async status(): Promise<[number, unknown]> {
    const runtime = this.getRuntime();
    const config = runtime.configStore.snapshot();
    const updateState = await runtime.updateControl.maybeRefresh();
    return [
      200,
      {
        config: publicConfig(config),
        version: this.version,
        upstream: runtime.upstream.status(),
        udp_control: runtime.udpCommands.snapshot(),
        state: runtime.state.snapshot(config.denied_devices ?? []),
        update_state: updateState,
        ...this.extraStatus(),
      },
    ];
  }

  private async saveSettings(body: Json): Promise<[number, unknown]> {
    const settings: Json = {
      target_mode: 'target_mode' in body ? body.target_mode : 'production',
      manual_url: 'manual_url' in body ? body.manual_url : '',
      gateway_id: 'gateway_id' in body ? body.gateway_id : '',
      enabled: pyBool('enabled' in body ? body.enabled : false),
    };
    // Absent (the setup wizard) keeps the saved value.
    if ('remote_management' in body) settings.remote_management = pyBool(body.remote_management);
    return this.reply(await this.getRuntime().operations().saveSettings(settings));
  }
}

/** Flask's request.get_json(silent=True) or {}: only a JSON content type is parsed; anything unusable is {}. */
async function readJsonBody(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'too_large');
    chunks.push(buffer);
  }
  const contentType = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  const isJson = contentType === 'application/json' || (contentType.startsWith('application/') && contentType.endsWith('+json'));
  if (!isJson || size === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    // Python: `... or {}`; a non-object (a list) made Flask fail with 500, treated as {} here.
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
  } catch {
    return {};
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
