// The host's log: appended to .run/logs/gateway.log and kept in a ring for
// the terminal UI (GatewayHostHandle.recentLogs / onLog).
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Logger } from '@nhgw/core';

import type { LogLevel, LogLine } from '../hostApi';

export const DEFAULT_LOG_RING = 500;
/** At open, a log larger than this is moved to gateway.log.1 (one generation kept). */
export const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

export interface HostLoggerOptions {
  /** null: memory only. */
  file?: string | null;
  ringSize?: number;
  /** Also print each line (e.g. to stderr when there is no terminal UI). */
  echo?: (text: string, line: LogLine) => void;
  now?: () => number;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** Local time, "2026-11-09 20:15:03.123". */
export function formatLogTime(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function formatLogLine(line: LogLine): string {
  return `${formatLogTime(line.at)} ${line.level.toUpperCase().padEnd(5)} ${line.message}`;
}

export class HostLogger implements Logger {
  private file: string | null;
  private readonly ringSize: number;
  private readonly ring: LogLine[] = [];
  private readonly listeners = new Set<(line: LogLine) => void>();
  private readonly echo: HostLoggerOptions['echo'];
  private readonly now: () => number;

  constructor(options: HostLoggerOptions = {}) {
    this.ringSize = Math.max(1, options.ringSize ?? DEFAULT_LOG_RING);
    this.echo = options.echo;
    this.now = options.now ?? Date.now;
    this.file = null;
    this.setFile(options.file ?? null);
  }

  /** Starts writing to `file` (rotating it first if large); null stops file output. */
  setFile(file: string | null): void {
    this.file = file;
    if (file === null) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > LOG_ROTATE_BYTES) {
        rmSync(`${file}.1`, { force: true });
        renameSync(file, `${file}.1`);
      }
    } catch {
      // Logging must never stop the Gateway.
    }
  }

  get filePath(): string | null {
    return this.file;
  }

  info(message: string): void {
    this.write('info', message);
  }

  warn(message: string): void {
    this.write('warn', message);
  }

  error(message: string): void {
    this.write('error', message);
  }

  recent(): readonly LogLine[] {
    return [...this.ring];
  }

  onLine(listener: (line: LogLine) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  write(level: LogLevel, message: string): void {
    const line: LogLine = { at: this.now(), level, message: String(message) };
    this.ring.push(line);
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
    const text = formatLogLine(line);
    if (this.file !== null) {
      try {
        appendFileSync(this.file, `${text}\n`, 'utf8');
      } catch {
        // A full disk or a removed folder: keep the in-memory log going.
      }
    }
    try {
      this.echo?.(text, line);
    } catch {
      // ignore
    }
    for (const listener of this.listeners) {
      try {
        listener(line);
      } catch {
        // A broken listener must not break logging.
      }
    }
  }
}
