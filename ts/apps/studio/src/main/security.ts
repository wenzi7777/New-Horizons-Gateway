// Content-Security-Policy, navigation rules and the `app://` file server for
// the renderer -- pure functions, tested without Electron.
//
// Production: the renderer is served from dist/renderer through the
// privileged `app://studio/` scheme (protocol.handle in main.ts), which sets
// the CSP on every response and serves nothing outside that folder.
// Development: the Vite dev server (VITE_DEV_SERVER_URL); its origin (and its
// HMR WebSocket) are allowed in addition.
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

export const APP_SCHEME = 'app';
export const APP_HOST = 'studio';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_ENTRY = `${APP_ORIGIN}/index.html`;
/** The start-up splash (a second Vite page, splash.html). */
export const SPLASH_ENTRY = `${APP_ORIGIN}/splash.html`;

/** The renderer's CSP: its own files only (plus the dev server in development). */
export function contentSecurityPolicy(devServerUrl: string | null): string {
  let dev = '';
  let devConnect = '';
  let devScript = '';
  if (devServerUrl) {
    const origin = new URL(devServerUrl).origin;
    dev = ` ${origin}`;
    devConnect = ` ${origin} ${origin.replace(/^http/, 'ws')}`;
    // @vitejs/plugin-react injects an inline preamble for Fast Refresh.
    devScript = ` 'unsafe-inline'${dev}`;
  }
  return [
    "default-src 'none'",
    `script-src 'self'${devScript}`,
    `style-src 'self' 'unsafe-inline'${dev}`,
    `img-src 'self' data: blob:${dev}`,
    `font-src 'self' data:${dev}`,
    `connect-src 'self'${devConnect}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** The origin the renderer may stay on (navigation elsewhere is blocked). */
export function rendererOrigin(devServerUrl: string | null): string {
  return devServerUrl ? new URL(devServerUrl).origin : APP_ORIGIN;
}

/** Whether `url` is a page of the renderer itself. */
export function isRendererUrl(url: string, devServerUrl: string | null): boolean {
  try {
    const parsed = new URL(url);
    if (devServerUrl) return parsed.origin === new URL(devServerUrl).origin;
    return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST;
  } catch {
    return false;
  }
}

/** http(s) URLs may open in the user's browser; nothing else leaves the app. */
export function isExternalWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * The file under `root` an `app://studio/...` request names, or null when it
 * climbs out of root. A path without an extension (a client-side route) is
 * the SPA's index.html.
 */
export function resolveAppRequest(root: string, requestUrl: string): string | null {
  let pathname: string;
  try {
    const url = new URL(requestUrl);
    if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null;
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  if (pathname === '/' || pathname === '' || extname(pathname) === '') pathname = '/index.html';
  const full = normalize(join(root, pathname));
  const base = normalize(root.endsWith(sep) ? root : root + sep);
  return full.startsWith(base) ? full : null;
}

/** Serves one `app://` request from `root` with the CSP and nosniff headers. */
export async function serveAppRequest(root: string, requestUrl: string, csp: string): Promise<Response> {
  const headers = { 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' };
  const file = resolveAppRequest(root, requestUrl);
  if (file === null) return new Response('Forbidden', { status: 403, headers });
  const info = await stat(file).catch(() => null);
  if (info === null || !info.isFile()) return new Response('Not Found', { status: 404, headers });
  const body = await readFile(file);
  return new Response(body, {
    status: 200,
    headers: { ...headers, 'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream' },
  });
}
