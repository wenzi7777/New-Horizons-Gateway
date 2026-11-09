import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { defaultRoot, resolveRuntimePaths } from '../src/paths';
import { GATEWAY_VERSION, PACKAGE_VERSION } from '../src/version';

const here = dirname(fileURLToPath(import.meta.url));

describe('resolveRuntimePaths', () => {
  it('lays out .run/ like the Python bootloader', () => {
    expect(resolveRuntimePaths({ root: '/srv/gw', env: {} })).toEqual({
      root: '/srv/gw',
      runDir: '/srv/gw/.run',
      configFile: '/srv/gw/.run/config/config.json',
      logFile: '/srv/gw/.run/logs/gateway.log',
      healthFile: '/srv/gw/.run/health.json',
      pidFile: '/srv/gw/.run/gateway.pid',
      downloadsDir: '/srv/gw/.run/downloads',
    });
  });

  it('defaults to the working directory, or the executable directory when packaged', () => {
    expect(resolveRuntimePaths({ env: {}, cwd: '/work', packaged: false }).root).toBe('/work');
    expect(resolveRuntimePaths({ env: {}, cwd: '/work', packaged: true, execPath: '/opt/nh/nh-gateway' }).root).toBe('/opt/nh');
    expect(defaultRoot({ cwd: '/w', packaged: true, execPath: 'bin/nh-gateway' })).toBe('/w/bin');
  });

  it("honours the Python Gateway's environment", () => {
    const paths = resolveRuntimePaths({
      cwd: '/work',
      packaged: false,
      env: {
        NEWHORIZONS_GATEWAY_RUNTIME_ROOT: '/data/run',
        NEWHORIZONS_GATEWAY_CONFIG: 'my.json',
        NEWHORIZONS_GATEWAY_LOG_PATH: '/var/log/gw.log',
        NEWHORIZONS_GATEWAY_HEALTH_PATH: '/data/h.json',
      },
    });
    expect(paths).toMatchObject({
      root: '/data',
      runDir: '/data/run',
      configFile: '/work/my.json',
      logFile: '/var/log/gw.log',
      healthFile: '/data/h.json',
      pidFile: '/data/run/gateway.pid',
    });
    expect(resolveRuntimePaths({ cwd: '/w', packaged: false, env: { NEWHORIZONS_GATEWAY_CONFIG_PATH: '/c.json' } }).configFile).toBe('/c.json');
    expect(resolveRuntimePaths({ cwd: '/w', packaged: false, env: { NEWHORIZONS_GATEWAY_APP_ROOT: '/app' } }).runDir).toBe('/app/.run');
  });

  it('explicit options win over the environment', () => {
    const env = { NEWHORIZONS_GATEWAY_CONFIG: '/env.json', NEWHORIZONS_GATEWAY_RUNTIME_ROOT: '/env/run' };
    expect(resolveRuntimePaths({ root: '/r', env }).configFile).toBe('/r/.run/config/config.json');
    expect(resolveRuntimePaths({ configFile: 'x.json', cwd: '/w', env }).configFile).toBe('/w/x.json');
  });
});

describe('version', () => {
  it('follows package.json', () => {
    const pkg = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')) as { version: string };
    expect(PACKAGE_VERSION).toBe(pkg.version);
    expect(GATEWAY_VERSION).toBe(`v${pkg.version}`);
  });
});

describe('assets', () => {
  it('serves tokens.css from @nhgw/ui-tokens', async () => {
    const { readAsset, webAssetSources, tokensCssPath } = await import('../src/assets');
    expect(tokensCssPath()).toBe(resolve(here, '../../ui-tokens/src/tokens.css'));
    expect(readAsset('tokens.css')!.toString('utf8')).toBe(readFileSync(resolve(here, '../../ui-tokens/src/tokens.css'), 'utf8'));
    expect(Object.keys(webAssetSources()).sort()).toEqual(
      ['app.css', 'app.js', 'i18n.js', 'index.html', 'markdown.js', 'select.js', 'theme.js', 'tokens.css'].sort(),
    );
    expect(readAsset('../package.json')).toBeNull();
  });
});
