// The sync client's one I/O port: an HTTP request with a JSON or raw body.
// FetchSyncHttp is the implementation for Node (Electron main) and React
// Native; tests inject a fake server.

export type SyncMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface SyncRequest {
  method: SyncMethod;
  url: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs: number;
}

export interface SyncResponse {
  status: number;
  text: string;
}

export interface SyncHttp {
  /** Resolves with any HTTP status; rejects only when no answer came (offline, timeout, TLS). */
  request(request: SyncRequest): Promise<SyncResponse>;
}

export class FetchSyncHttp implements SyncHttp {
  async request(request: SyncRequest): Promise<SyncResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        // Raw chunks go as a standalone ArrayBuffer: React Native's fetch takes
        // that (not a Uint8Array view); Node's takes either.
        ...(request.body !== undefined
          ? { body: (typeof request.body === 'string' ? request.body : request.body.slice().buffer) as NonNullable<Parameters<typeof fetch>[1]>['body'] }
          : {}),
        signal: controller.signal,
      });
      return { status: response.status, text: await response.text() };
    } catch (error) {
      if (controller.signal.aborted) throw new Error('timeout');
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timer);
    }
  }
}
