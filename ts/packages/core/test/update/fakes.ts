import { createHash } from 'node:crypto';

import type { Clock, Http, Sha256 } from '../../src/ports';
import type { StagedUpdate, StageInfo, UpdateInstaller } from '../../src/update';

export class FakeClock implements Clock {
  mono = 0;
  wallMs = 1_762_000_000_000;
  nowMs() {
    return this.wallMs + this.mono;
  }
  nowEpochUs() {
    return (this.wallMs + this.mono) * 1000;
  }
  monotonicMs() {
    return this.mono;
  }
}

/** URL -> body; a missing URL rejects like a 404. */
export class FakeHttp implements Http {
  texts = new Map<string, string>();
  bytes = new Map<string, Uint8Array>();
  requests: string[] = [];
  /** Content-Length reported to onProgress; null = unknown. */
  reportTotal = true;

  async getText(url: string, _timeoutMs: number): Promise<string> {
    this.requests.push(url);
    const text = this.texts.get(url);
    if (text === undefined) throw new Error(`HTTP Error 404: Not Found (${url})`);
    return text;
  }

  async getBytes(url: string, _timeoutMs: number, onProgress?: (received: number, total: number | null) => void): Promise<Uint8Array> {
    this.requests.push(url);
    const body = this.bytes.get(url);
    if (body === undefined) throw new Error(`HTTP Error 404: Not Found (${url})`);
    const total = this.reportTotal ? body.length : null;
    for (let received = 0; received < body.length; received += 64 * 1024) onProgress?.(received, total);
    onProgress?.(body.length, total);
    return body;
  }
}

export const nodeSha256: Sha256 = async (data) => createHash('sha256').update(data).digest('hex');

export class FakeInstaller implements UpdateInstaller {
  stagedUpdate: StagedUpdate | null = null;
  stagedBytes: Uint8Array | null = null;
  stagedInfo: StageInfo | null = null;
  activations = 0;
  failStage: string | null = null;
  failActivate: string | null = null;
  rollbackReason = '';
  progressSeen: number[] = [];

  async stage(bytes: Uint8Array, info: StageInfo, onProgress?: (pct: number) => void): Promise<void> {
    if (this.failStage) throw new Error(this.failStage);
    for (const pct of [10, 50, 100]) {
      onProgress?.(pct);
      this.progressSeen.push(pct);
    }
    this.stagedBytes = bytes;
    this.stagedInfo = info;
    this.stagedUpdate = { version: info.version };
  }

  staged(): StagedUpdate | null {
    return this.stagedUpdate;
  }

  async activate(): Promise<void> {
    if (this.failActivate) throw new Error(this.failActivate);
    this.activations += 1;
  }

  bootStatus() {
    return { rollbackReason: this.rollbackReason, healthReady: true };
  }
}
