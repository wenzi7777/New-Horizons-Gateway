// WsConnector on Node 22's global WebSocket (undici). The connection exposes
// bufferedAmount, so UpstreamClient pauses its drain when the socket backs
// up, as Python's blocking send did.
import type { Logger, WsConnection, WsConnector, WsHandlers } from '@nhgw/core';
import { silentLogger } from '@nhgw/core';

type WebSocketCtor = new (url: string, protocolsOrInit?: unknown) => WebSocket;

export interface NodeWsConnectorOptions {
  logger?: Logger;
  /** Defaults to globalThis.WebSocket. */
  WebSocketImpl?: WebSocketCtor;
}

export interface NodeWsConnection extends WsConnection {
  readonly bufferedAmount: number;
}

function eventMessage(event: Event): string {
  const withMessage = event as Event & { message?: unknown; error?: { message?: unknown } };
  const message = withMessage.message || withMessage.error?.message;
  return message ? String(message) : 'websocket error';
}

export class NodeWsConnector implements WsConnector {
  private readonly logger: Logger;
  private readonly impl: WebSocketCtor | undefined;
  private warnedHeaders = false;

  constructor(options: NodeWsConnectorOptions = {}) {
    this.logger = options.logger ?? silentLogger;
    this.impl = options.WebSocketImpl ?? (globalThis.WebSocket as unknown as WebSocketCtor | undefined);
  }

  connect(url: string, headers: Record<string, string>, handlers: WsHandlers): NodeWsConnection {
    const Impl = this.impl;
    if (!Impl) throw new Error('websocket_unavailable');
    let ws: WebSocket;
    if (Object.keys(headers).length > 0) {
      // The WHATWG constructor has no headers. undici takes a non-standard
      // init object with `headers` on recent versions and ignores the key on
      // older ones. No config sets a token today, so this is never used.
      if (!this.warnedHeaders) {
        this.warnedHeaders = true;
        this.logger.warn(
          `upstream: request headers (${Object.keys(headers).join(', ')}) passed through undici's WebSocket init; ` +
            'they are dropped on Node versions without header support',
        );
      }
      ws = new Impl(url, { headers });
    } else {
      ws = new Impl(url);
    }
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => handlers.onOpen());
    ws.addEventListener('message', (event: MessageEvent) => {
      const data: unknown = event.data;
      if (typeof data === 'string') handlers.onMessage(data);
      else if (data instanceof ArrayBuffer) handlers.onMessage(new Uint8Array(data));
      else if (ArrayBuffer.isView(data)) handlers.onMessage(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    });
    ws.addEventListener('error', (event: Event) => handlers.onError(eventMessage(event)));
    ws.addEventListener('close', (event: Event & { code?: number; reason?: string }) => {
      handlers.onClose(`connection closed (${event.code ?? 0}${event.reason ? `: ${event.reason}` : ''})`);
    });
    return {
      send(text: string): void {
        if (ws.readyState !== 1) throw new Error('websocket_not_open');
        ws.send(text);
      },
      close(): void {
        if (ws.readyState === 2 || ws.readyState === 3) return;
        ws.close();
      },
      get bufferedAmount(): number {
        return ws.bufferedAmount;
      },
    };
  }
}
