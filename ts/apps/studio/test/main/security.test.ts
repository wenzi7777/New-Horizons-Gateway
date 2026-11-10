import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { contentSecurityPolicy, isExternalWebUrl, isRendererUrl, resolveAppRequest, serveAppRequest } from '../../src/main/security';

const root = mkdtempSync(join(tmpdir(), 'nh-studio-renderer-'));
mkdirSync(join(root, 'assets'));
writeFileSync(join(root, 'index.html'), '<!doctype html><title>NH Studio</title>');
writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)');
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('renderer security', () => {
  it('production CSP allows only the app’s own files', () => {
    const csp = contentSecurityPolicy(null);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("connect-src 'self';");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/http:|ws:/);
  });

  it('development CSP adds the Vite dev server and its HMR socket', () => {
    const csp = contentSecurityPolicy('http://localhost:5173/');
    expect(csp).toContain("script-src 'self' 'unsafe-inline' http://localhost:5173");
    expect(csp).toContain("connect-src 'self' http://localhost:5173 ws://localhost:5173");
  });

  it('keeps navigation on the renderer and lets only http(s) out', () => {
    expect(isRendererUrl('app://studio/index.html#/devices', null)).toBe(true);
    expect(isRendererUrl('app://other/index.html', null)).toBe(false);
    expect(isRendererUrl('https://evil.example/', null)).toBe(false);
    expect(isRendererUrl('http://localhost:5173/x', 'http://localhost:5173/')).toBe(true);
    expect(isRendererUrl('http://localhost:5174/x', 'http://localhost:5173/')).toBe(false);
    expect(isExternalWebUrl('https://a.example')).toBe(true);
    expect(isExternalWebUrl('file:///etc/passwd')).toBe(false);
  });

  it('serves app:// from the renderer folder only, with the CSP', async () => {
    expect(resolveAppRequest(root, 'app://studio/')).toBe(join(root, 'index.html'));
    expect(resolveAppRequest(root, 'app://studio/devices/3CDC')).toBe(join(root, 'index.html'));
    expect(resolveAppRequest(root, 'app://studio/assets/app.js')).toBe(join(root, 'assets', 'app.js'));
    // URL parsing already folds dot segments into the root; an encoded slash cannot climb out either.
    expect(resolveAppRequest(root, 'app://studio/%2e%2e/%2e%2e/etc/passwd.txt')).toBe(join(root, 'etc', 'passwd.txt'));
    expect(resolveAppRequest(root, 'app://studio/a%2F..%2F..%2Fsecret.txt')).toBeNull();
    expect(resolveAppRequest(root, 'app://other/index.html')).toBeNull();
    const ok = await serveAppRequest(root, 'app://studio/assets/app.js', 'default-src x');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(ok.headers.get('content-security-policy')).toBe('default-src x');
    expect(await ok.text()).toBe('console.log(1)');
    expect((await serveAppRequest(root, 'app://studio/assets/missing.js', 'x')).status).toBe(404);
    expect((await serveAppRequest(root, 'app://studio/a%2F..%2F..%2Fsecret.txt', 'x')).status).toBe(403);
  });
});
