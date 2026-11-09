// First start next to (or instead of) the Python Gateway: take its settings
// over, so the Desktop sees the same Gateway (same gateway_id) and nothing
// has to be set up again (docs/ts-port-plan.md, "設定帶過去").
//
// - The Python bootloader kept its config at .run/config/config.json, the
//   very file this host uses: dropped into the old folder, the new binary
//   simply reads it. That still counts as taking it over (once), so the UIs
//   can say so; it is recognised by the bootloader's .run/boot_state.json.
// - Older layouts kept it elsewhere: .run/config.json (start.py before the
//   bootloader), .run/host_gateway_config.json, and gateway_config.json in
//   the working directory (config_store.py's default). Those are copied,
//   keys unchanged, through the core's normalizeConfig. The old file is left alone.
//
// Either way .run/legacy-import.json records it; /api/status and the console
// status carry it as `legacy_import`.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { defaultConfig, normalizeConfig, type Logger, silentLogger } from '@nhgw/core';

import type { RuntimePaths } from './hostApi';
import { JsonFileStore, serializeJson, writeFileAtomicSync } from './adapters/jsonStore';
import { legacyImportFile } from './paths';
import { CONFIG_FLOAT_KEYS } from './pyJson';

export interface LegacyImportRecord {
  /** ISO time of the import. */
  imported_at: string;
  /** The Python Gateway's config file the settings came from. */
  source: string;
  /** true: the Python file was at this host's own config path and is used as is. */
  in_place: boolean;
  gateway_id: string;
}

export interface LegacyImportOptions {
  /** Where to look besides the root (Python's default config lived in the working directory). Default process.cwd(). */
  cwd?: string;
  logger?: Logger;
  now?: () => Date;
}

/** The places a Python Gateway may have left its config, in the order they are tried. */
export function legacyConfigCandidates(paths: RuntimePaths, cwd: string = process.cwd()): string[] {
  const out: string[] = [];
  const add = (file: string) => {
    const full = resolve(file);
    if (full !== resolve(paths.configFile) && !out.includes(full)) out.push(full);
  };
  for (const base of [paths.root, resolve(cwd)]) {
    add(join(base, '.run', 'config', 'config.json'));
    add(join(base, '.run', 'config.json'));
    add(join(base, '.run', 'host_gateway_config.json'));
    add(join(base, 'gateway_config.json'));
  }
  return out;
}

export function readLegacyImportRecord(paths: RuntimePaths): LegacyImportRecord | null {
  try {
    const data = JSON.parse(readFileSync(legacyImportFile(paths), 'utf8')) as unknown;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const record = data as Partial<LegacyImportRecord>;
      return {
        imported_at: String(record.imported_at ?? ''),
        source: String(record.source ?? ''),
        in_place: Boolean(record.in_place),
        gateway_id: String(record.gateway_id ?? ''),
      };
    }
  } catch {
    // none, or unreadable: nothing to say
  }
  return null;
}

function writeRecord(paths: RuntimePaths, record: LegacyImportRecord): void {
  writeFileAtomicSync(legacyImportFile(paths), serializeJson(record));
}

/** The Python bootloader's own files in .run/: an in-place upgrade from the Python Gateway. */
function isPythonRunDir(paths: RuntimePaths): boolean {
  return existsSync(join(paths.runDir, 'boot_state.json')) || existsSync(join(paths.runDir, 'slots'));
}

/**
 * Runs before the config is loaded. Returns the record when settings were
 * taken over now; null when there was nothing to take over or it already
 * happened (readLegacyImportRecord() has the earlier one).
 */
export async function importLegacyConfig(paths: RuntimePaths, options: LegacyImportOptions = {}): Promise<LegacyImportRecord | null> {
  const logger = options.logger ?? silentLogger;
  const now = options.now ?? (() => new Date());

  if (existsSync(paths.configFile)) {
    if (readLegacyImportRecord(paths) !== null || !isPythonRunDir(paths)) return null;
    let gatewayId = '';
    try {
      const data = JSON.parse(readFileSync(paths.configFile, 'utf8')) as Record<string, unknown>;
      gatewayId = typeof data?.gateway_id === 'string' ? data.gateway_id : '';
    } catch {
      // The config loader reports a broken file.
    }
    const record: LegacyImportRecord = { imported_at: now().toISOString(), source: paths.configFile, in_place: true, gateway_id: gatewayId };
    writeRecord(paths, record);
    logger.info(`using the previous Gateway's settings in place (${paths.configFile})`);
    return record;
  }

  for (const candidate of legacyConfigCandidates(paths, options.cwd)) {
    if (!existsSync(candidate)) continue;
    let config;
    try {
      const data = JSON.parse(readFileSync(candidate, 'utf8').replace(/^﻿/, '')) as unknown;
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not a JSON object');
      config = normalizeConfig({ ...defaultConfig(), ...(data as Record<string, unknown>) });
    } catch (error) {
      logger.warn(`ignoring previous Gateway config ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    await new JsonFileStore(paths.configFile, { floatKeys: CONFIG_FLOAT_KEYS }).save(config);
    const record: LegacyImportRecord = {
      imported_at: now().toISOString(),
      source: candidate,
      in_place: false,
      gateway_id: config.gateway_id,
    };
    writeRecord(paths, record);
    logger.info(`imported settings from the previous Gateway: ${candidate}${config.gateway_id ? ` (gateway_id ${config.gateway_id})` : ''}`);
    return record;
  }
  return null;
}
