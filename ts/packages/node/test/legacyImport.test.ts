import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { importLegacyConfig, legacyConfigCandidates, readLegacyImportRecord } from '../src/legacyImport';
import { legacyImportFile, resolveRuntimePaths } from '../src/paths';
import { tempDir } from './helpers';

const PY_CONFIG = {
  enabled: true,
  gateway_id: 'nh-gateway-abc123',
  gateway_name: 'Lab Gateway',
  target_mode: 'manual',
  manual_url: 'ws://10.0.0.5:5051/newhorizons/gateway/ws',
  update_channel: 'beta',
  denied_devices: ['aabbccddeeff'],
  remote_management: false,
  listen_udp_port: 13250,
  control_stale_sec: 16.0,
  auth_token: 'old',
  some_future_key: 'kept',
};

function write(file: string, value: unknown) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

describe('legacy import', () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  function setup() {
    const root = tempDir();
    const cwd = tempDir();
    cleanup = () => {
      root.cleanup();
      cwd.cleanup();
    };
    return { root: root.dir, cwd: cwd.dir, paths: resolveRuntimePaths({ root: root.dir, env: {} }) };
  }

  it('does nothing on a fresh install', async () => {
    const { paths, cwd } = setup();
    expect(await importLegacyConfig(paths, { cwd })).toBeNull();
    expect(existsSync(paths.configFile)).toBe(false);
    expect(readLegacyImportRecord(paths)).toBeNull();
  });

  it.each([['.run/config.json'], ['.run/host_gateway_config.json'], ['gateway_config.json']])(
    'imports %s from the same folder, keeping gateway_id and every key',
    async (relative) => {
      const { root, paths, cwd } = setup();
      write(join(root, relative), PY_CONFIG);
      const record = await importLegacyConfig(paths, { cwd });
      expect(record).toMatchObject({ source: join(root, relative), in_place: false, gateway_id: 'nh-gateway-abc123' });
      const saved = JSON.parse(readFileSync(paths.configFile, 'utf8'));
      expect(saved).toMatchObject({
        enabled: true,
        gateway_id: 'nh-gateway-abc123',
        gateway_name: 'Lab Gateway',
        target_mode: 'manual',
        manual_url: 'ws://10.0.0.5:5051/newhorizons/gateway/ws',
        server_url: 'ws://10.0.0.5:5051/newhorizons/gateway/ws',
        update_channel: 'beta',
        denied_devices: ['AABBCCDDEEFF'],
        remote_management: false,
        some_future_key: 'kept',
        listen_web_port: 5052,
      });
      expect(saved).not.toHaveProperty('auth_token');
      expect(readFileSync(paths.configFile, 'utf8')).toContain('"control_stale_sec": 16.0,');
      expect(readLegacyImportRecord(paths)).toEqual(record);
      // The Python file is left alone, and a second start imports nothing.
      expect(JSON.parse(readFileSync(join(root, relative), 'utf8'))).toEqual(PY_CONFIG);
      expect(await importLegacyConfig(paths, { cwd })).toBeNull();
    },
  );

  it("finds the Python Gateway's .run/config/config.json in the working directory", async () => {
    const { cwd, paths } = setup();
    write(join(cwd, '.run', 'config', 'config.json'), PY_CONFIG);
    expect(await importLegacyConfig(paths, { cwd })).toMatchObject({ source: join(cwd, '.run', 'config', 'config.json'), in_place: false });
    expect(JSON.parse(readFileSync(paths.configFile, 'utf8')).gateway_id).toBe('nh-gateway-abc123');
  });

  it('prefers the bootloader layout over older ones, and skips broken files', async () => {
    const { root, cwd, paths } = setup();
    write(join(root, '.run', 'config.json'), '{not json');
    write(join(cwd, 'gateway_config.json'), { ...PY_CONFIG, gateway_id: 'from-cwd' });
    expect((await importLegacyConfig(paths, { cwd }))!.gateway_id).toBe('from-cwd');
    expect(legacyConfigCandidates(paths, cwd)[0]).toBe(join(root, '.run', 'config.json'));
    expect(legacyConfigCandidates(paths, cwd)).not.toContain(paths.configFile);
  });

  it('an in-place Python install (same config path) is used as is and recorded once', async () => {
    const { root, cwd, paths } = setup();
    write(paths.configFile, PY_CONFIG);
    const before = readFileSync(paths.configFile, 'utf8');
    // Without the bootloader's files it is just this host's own config.
    expect(await importLegacyConfig(paths, { cwd })).toBeNull();
    write(join(root, '.run', 'boot_state.json'), { active_slot: 'slot_a' });
    const record = await importLegacyConfig(paths, { cwd });
    expect(record).toMatchObject({ source: paths.configFile, in_place: true, gateway_id: 'nh-gateway-abc123' });
    expect(readFileSync(paths.configFile, 'utf8')).toBe(before);
    expect(existsSync(legacyImportFile(paths))).toBe(true);
    expect(await importLegacyConfig(paths, { cwd })).toBeNull();
    expect(readLegacyImportRecord(paths)).toEqual(record);
  });
});
