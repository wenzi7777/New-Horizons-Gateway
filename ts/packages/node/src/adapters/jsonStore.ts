// A JSON document on disk with atomic replacement (temp file in the same
// directory, fsync, rename), written the way the Python Gateway wrote it:
// config_store.py used json.dump(indent=2, sort_keys=True, ensure_ascii=False)
// plus a trailing newline, so a config saved here still diffs cleanly
// against one the Python Gateway saved.
import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync, closeSync, writeSync, fsyncSync, renameSync, rmSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { JsonStore } from '@nhgw/core';

import { type PyJsonOptions, pyJsonDumps } from '../pyJson';

export interface JsonFileStoreOptions extends PyJsonOptions {
  /** Append "\n" (config_store did; console_runtime did not). Default true. */
  trailingNewline?: boolean;
}

const CONFIG_STYLE: JsonFileStoreOptions = { indent: 2, sortKeys: true, ensureAscii: false, trailingNewline: true };

function tempPath(path: string): string {
  // tempfile.mkstemp(prefix=<name>, suffix=".tmp", dir=<dir>)
  return join(dirname(path), `${basename(path)}${randomBytes(4).toString('hex')}.tmp`);
}

export function serializeJson(value: unknown, options: JsonFileStoreOptions = CONFIG_STYLE): string {
  const { trailingNewline = true, ...dump } = options;
  return pyJsonDumps(value, dump) + (trailingNewline ? '\n' : '');
}

/** Atomically replaces `path` with `text` (synchronous: small status files written from timers). */
export function writeFileAtomicSync(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tempPath(path);
  try {
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, text, null, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export async function writeFileAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = tempPath(path);
  try {
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export class JsonFileStore<T> implements JsonStore<T> {
  readonly path: string;
  private readonly options: JsonFileStoreOptions;
  private writing: Promise<void> = Promise.resolve();

  constructor(path: string, options: JsonFileStoreOptions = {}) {
    this.path = path;
    this.options = { ...CONFIG_STYLE, ...options };
  }

  /** null when the file does not exist; throws, naming the file, when it is not JSON. */
  async load(): Promise<T | null> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      return JSON.parse(text.replace(/^﻿/, '')) as T;
    } catch (error) {
      throw new Error(`${this.path} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  /** Saves are serialized: the last call's value is what ends up on disk. */
  save(value: T): Promise<void> {
    const text = serializeJson(value, this.options);
    const next = this.writing.catch(() => undefined).then(() => writeFileAtomic(this.path, text));
    this.writing = next;
    return next;
  }
}
