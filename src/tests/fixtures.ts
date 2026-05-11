import { test as baseTest, vi } from 'vitest';
import { Container } from '../lib/container';

type EventHandler = (event: unknown) => void;

export class MockWebSocket {
  eventListeners: Record<string, EventHandler[]> = {
    message: [],
    close: [],
    error: [],
  };

  accept = vi.fn<() => void>();
  send = vi.fn<(data: string | ArrayBuffer) => void>();
  close = vi.fn<(code?: number, reason?: string) => void>();

  addEventListener(type: string, handler: EventHandler) {
    this.eventListeners[type].push(handler);
  }
}

export const webSocketPairSpy = vi.fn(function WebSocketPair() {
  return {
    0: new MockWebSocket(),
    1: new MockWebSocket(),
  };
});

vi.stubGlobal('WebSocketPair', webSocketPairSpy);

export function makeMockCtx() {
  const ctx = {
    storage: {
      get: vi.fn<(key: string) => Promise<unknown>>(),
      put: vi.fn<(key: string, value: unknown) => Promise<void>>().mockResolvedValue(undefined),
      delete: vi.fn<(key: string) => Promise<boolean>>().mockResolvedValue(true),
      setAlarm: vi.fn<(scheduledTime: number) => Promise<void>>().mockResolvedValue(undefined),
      sync: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      kv: {
        get: vi.fn<(key: string) => Promise<unknown>>(),
        put: vi.fn<(key: string, value: unknown) => Promise<void>>().mockResolvedValue(undefined),
        delete: vi.fn<(key: string) => Promise<boolean>>().mockResolvedValue(true),
      },
      sql: {
        exec: vi.fn<(query: string) => unknown[]>().mockReturnValue([]),
      },
    },
    blockConcurrencyWhile: vi.fn(<T>(fn: () => Promise<T>) => fn()),
    abort: vi.fn<(reason?: string) => void>(),
    id: { toString: vi.fn<() => string>().mockReturnValue('test-container-id') },
    exports: {
      ContainerProxy: vi
        .fn<(params: { props: object }) => { fetch: ReturnType<typeof vi.fn> }>()
        .mockReturnValue({ fetch: vi.fn() }),
    },
    container: {
      running: false,
      start: vi.fn<() => void>(),
      signal: vi.fn<(signo: number) => void>(),
      destroy: vi.fn<() => Promise<void>>(),
      monitor: vi.fn<() => Promise<unknown>>().mockReturnValue(new Promise(() => {})),
      interceptOutboundHttp: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      interceptOutboundHttps: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      interceptAllOutboundHttp: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      getTcpPort: vi.fn<(port: number) => { fetch: ReturnType<typeof vi.fn> }>(),
    },
  };

  ctx.container.start.mockImplementation(() => {
    ctx.container.running = true;
  });

  ctx.container.getTcpPort.mockReturnValue({
    fetch: vi.fn((_url: string, init?: RequestInit) => {
      if (init?.headers && (init.headers as Headers).get('Upgrade') === 'websocket') {
        return Promise.resolve({
          status: 200,
          webSocket: new MockWebSocket(),
          headers: new Headers(),
        });
      }
      return Promise.resolve({
        status: 200,
        webSocket: null,
        body: null,
      });
    }),
  });

  return ctx;
}

export type MockCtx = ReturnType<typeof makeMockCtx>;

export const test = baseTest
  .extend('mockCtx', () => makeMockCtx())
  .extend('container', ({ mockCtx }) => {
    // @ts-expect-error - mockCtx is a partial stand-in for DurableObjectState
    const container = new Container(mockCtx, {});
    container.defaultPort = 8080;
    return container;
  });
