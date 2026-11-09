// Http on the global fetch: manifests, release notes and update downloads.
import type { Http } from '@nhgw/core';

export interface FetchHttpOptions {
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timed out';
    const cause = (error as Error & { cause?: unknown }).cause;
    const causeText = cause instanceof Error ? cause.message : cause ? String(cause) : '';
    return causeText && !error.message.includes(causeText) ? `${error.message}: ${causeText}` : error.message;
  }
  return String(error);
}

export class FetchHttp implements Http {
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;

  constructor(options: FetchHttpOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.headers = options.userAgent ? { 'User-Agent': options.userAgent } : {};
  }

  private async open(url: string, signal: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal, headers: this.headers, redirect: 'follow' });
    } catch (error) {
      throw new Error(describe(error));
    }
    if (!response.ok) {
      // urllib's HTTPError text, which the web UI shows as last_error.
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
    }
    return response;
  }

  async getText(url: string, timeoutMs: number): Promise<string> {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await this.open(url, signal);
    try {
      return await response.text();
    } catch (error) {
      throw new Error(describe(error));
    }
  }

  async getBytes(url: string, timeoutMs: number, onProgress?: (received: number, total: number | null) => void): Promise<Uint8Array> {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await this.open(url, signal);
    const length = Number(response.headers.get('content-length'));
    const total = Number.isFinite(length) && length > 0 ? length : null;
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      if (response.body === null) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        onProgress?.(bytes.length, total);
        return bytes;
      }
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        onProgress?.(received, total);
      }
    } catch (error) {
      throw new Error(describe(error));
    }
    const out = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}
