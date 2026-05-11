import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('cloudflare:workers', () => {
  class MockDurableObject {
    ctx: unknown;
    env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  }

  class MockWorkerEntrypoint {}

  return {
    DurableObject: MockDurableObject,
    WorkerEntrypoint: MockWorkerEntrypoint,
  };
});

import { Container } from '../lib/container';
import { getRandom } from '../lib/utils';

// Mock async hooks
vi.mock('node:async_hooks', () => {
  return {
    AsyncLocalStorage: class MockAsyncLocalStorage {
      getStore() {
        return null;
      }
      run(store: any, fn: Function) {
        return fn();
      }
    },
  };
});

class MockWebSocket {
  eventListeners: Record<string, Function[]> = {
    message: [],
    close: [],
    error: [],
  };

  accept = vi.fn();
  send = vi.fn();
  close = vi.fn();

  addEventListener(type: string, handler: Function) {
    this.eventListeners[type].push(handler);
  }
}

vi.stubGlobal('WebSocketPair', function WebSocketPair() {
  return {
    0: new MockWebSocket(),
    1: new MockWebSocket(),
  };
});

// Add required types for tests
declare global {
  interface DurableObjectNamespace {
    idFromName(name: string): DurableObjectId;
    idFromString(id: string): DurableObjectId;
    get(id: DurableObjectId): DurableObjectStub;
  }

  interface DurableObjectId {
    toString(): string;
  }

  interface DurableObjectStub {
    fetch(request: Request): Promise<Response>;
  }
}

// Create container tests
describe('Container', () => {
  let mockCtx: any;
  let container: Container;

  beforeEach(() => {
    // Create a mock context with necessary container methods
    mockCtx = {
      storage: {
        get: vi.fn(),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        setAlarm: vi.fn().mockResolvedValue(undefined),
        sync: vi.fn().mockResolvedValue(undefined),
        kv: {
          get: vi.fn(),
          put: vi.fn().mockResolvedValue(undefined),
          delete: vi.fn().mockResolvedValue(undefined),
        },
        sql: {
          exec: vi.fn().mockReturnValue([]),
        },
      },
      blockConcurrencyWhile: vi.fn(fn => fn()),
      abort: vi.fn(),
      id: { toString: vi.fn().mockReturnValue('test-container-id') },
      exports: {
        ContainerProxy: vi.fn().mockReturnValue({ fetch: vi.fn() }),
      },
      container: {
        running: false,
        start: vi.fn(() => {
          mockCtx.container.running = true;
        }),
        signal: vi.fn(),
        destroy: vi.fn(),
        monitor: vi.fn().mockReturnValue(new Promise(() => {})),
        interceptOutboundHttp: vi.fn().mockResolvedValue(undefined),
        interceptOutboundHttps: vi.fn().mockResolvedValue(undefined),
        interceptAllOutboundHttp: vi.fn().mockResolvedValue(undefined),
        getTcpPort: vi.fn().mockReturnValue({
          fetch: vi.fn().mockImplementation((url, init) => {
            // Check if this is a WebSocket request
            if (init?.headers && (init.headers as Headers).get('Upgrade') === 'websocket') {
              // Create a mock WebSocket
              const mockWs = new MockWebSocket();
              return Promise.resolve({
                status: 200,
                webSocket: mockWs,
                headers: new Headers(),
              });
            }

            // Regular HTTP response
            return Promise.resolve({
              status: 200,
              webSocket: null,
              body: null,
            });
          }),
        }),
      },
    };

    // Create a container instance with the mock context
    // @ts-ignore - ignore TypeScript errors for testing
    container = new Container(mockCtx, {});
    // Add ctx property for testing
    (container as any).ctx = mockCtx;
    // Add defaultPort for testing
    container.defaultPort = 8080;
  });

  test('should initialize with default values', () => {
    expect(container.defaultPort).toBe(8080);
    expect(container.sleepAfter).toBe('10m');
  });

  test('startAndWaitForPorts should start container if not running (single port)', async () => {
    // @ts-ignore - ignore TypeScript errors for testing
    await container.startAndWaitForPorts(8080);

    expect(mockCtx.container.start).toHaveBeenCalled();
    expect(mockCtx.container.getTcpPort).toHaveBeenCalledWith(8080);
  });

  test('startAndWaitForPorts should check multiple ports if provided', async () => {
    // @ts-ignore - ignore TypeScript errors for testing
    await container.startAndWaitForPorts([8080, 9090]);

    expect(mockCtx.container.start).toHaveBeenCalled();
    expect(mockCtx.container.getTcpPort).toHaveBeenCalledWith(8080);
    expect(mockCtx.container.getTcpPort).toHaveBeenCalledWith(9090);
  });

  test('startAndWaitForPorts should use requiredPorts if defined and no ports specified', async () => {
    // Add required ports to container
    container.requiredPorts = [3000, 4000];

    // @ts-ignore - ignore TypeScript errors for testing
    await container.startAndWaitForPorts();

    expect(mockCtx.container.start).toHaveBeenCalled();
    expect(mockCtx.container.getTcpPort).toHaveBeenCalledWith(3000);
    expect(mockCtx.container.getTcpPort).toHaveBeenCalledWith(4000);
  });

  test('startAndWaitForPorts should use defaultPort if no ports specified and no requiredPorts', async () => {
    // @ts-ignore - ignore TypeScript errors for testing
    await container.startAndWaitForPorts();

    expect(mockCtx.container.start).toHaveBeenCalled();
    expect(mockCtx.container.getTcpPort).toHaveBeenCalledWith(8080);
  });

  test('startAndWaitForPorts should surface rate-limited startup errors on the final retry', async () => {
    vi.spyOn(container, 'onError').mockImplementation(error => {
      throw error;
    });
    mockCtx.container.monitor = vi.fn().mockReturnValue({
      catch: vi.fn().mockResolvedValue(new Error('you are requesting too many containers per second')),
    });
    mockCtx.container.getTcpPort = vi.fn().mockReturnValue({
      fetch: vi.fn().mockRejectedValue(new Error('unexpected startup failure')),
    });

    await expect(
      // @ts-ignore - ignore TypeScript errors for testing
      container.startAndWaitForPorts({
        ports: 8080,
        cancellationOptions: { instanceGetTimeoutMS: 1, waitInterval: 1 },
      })
    ).rejects.toThrow('you are requesting too many containers per second');
  });

  test('startAndWaitForPorts should abort the durable object on final network loss', async () => {
    mockCtx.container.monitor = vi.fn().mockReturnValue({
      catch: vi
        .fn()
        .mockResolvedValue(
          new Error('there is no container instance that can be provided to this durable object')
        ),
    });
    mockCtx.container.getTcpPort = vi.fn().mockReturnValue({
      fetch: vi.fn().mockRejectedValue(new Error('Network connection lost')),
    });

    await expect(
      // @ts-ignore - ignore TypeScript errors for testing
      container.startAndWaitForPorts({
        ports: 8080,
        cancellationOptions: { instanceGetTimeoutMS: 1, waitInterval: 1 },
      })
    ).rejects.toThrow('there is no container instance that can be provided to this durable object');

    expect(mockCtx.abort).toHaveBeenCalled();
  });

  test('startAndWaitForPorts should fall back to default health check port', async () => {
    // Create a container without defaultPort or requiredPorts
    // @ts-ignore - ignore TypeScript errors for testing
    const containerWithoutPort = new Container(mockCtx, {});
    // Add ctx property for testing
    (containerWithoutPort as any).ctx = mockCtx;

    // @ts-ignore - ignore TypeScript errors for testing
    await containerWithoutPort.startAndWaitForPorts();

    // Should start container
    expect(mockCtx.container.start).toHaveBeenCalled();
    expect(mockCtx.container.getTcpPort).toHaveBeenCalledWith(33);
  });

  test('containerFetch should forward requests to container', async () => {
    const mockRequest = new Request('https://example.com/test?query=value', {
      method: 'GET',
      headers: new Headers({
        'Content-Type': 'application/json',
      }),
    });

    // Make mockCtx.container.running true for this test
    mockCtx.container.running = true;
    mockCtx.storage.get.mockResolvedValue({ status: 'healthy', lastChange: Date.now() });

    // @ts-ignore - ignore TypeScript errors for testing
    await container.containerFetch(mockRequest);

    const tcpPort = mockCtx.container.getTcpPort.mock.results[0].value;
    expect(tcpPort.fetch).toHaveBeenCalled();

    // Just make sure that tcpPort.fetch was called - the exact URL is tested in the container.ts implementation
    expect(tcpPort.fetch).toHaveBeenCalledWith(expect.any(String), expect.any(Object));
  });

  test('containerFetch should return 429 when startup is rate limited', async () => {
    const mockRequest = new Request('https://example.com/test', { method: 'GET' });
    const startSpy = vi
      .spyOn(container, 'startAndWaitForPorts')
      .mockRejectedValue(new Error('you are requesting too many containers per second'));

    // @ts-ignore - ignore TypeScript errors for testing
    const response = await container.containerFetch(mockRequest);

    expect(startSpy).toHaveBeenCalledWith(8080, { abort: mockRequest.signal });
    expect(response.status).toBe(429);
    await expect(response.text()).resolves.toBe('you are requesting too many containers per second');
  });

  test('containerFetch should throw error when no port is specified', async () => {
    const mockRequest = new Request('https://example.com/test', {
      method: 'GET',
    });

    // Make mockCtx.container.running true for this test
    mockCtx.container.running = true;
    mockCtx.storage.get.mockResolvedValue({ status: 'healthy', lastChange: Date.now() });

    // Create a container without defaultPort
    // @ts-ignore - ignore TypeScript errors for testing
    const containerWithoutPort = new Container(mockCtx, {});
    // Add ctx property for testing
    (containerWithoutPort as any).ctx = mockCtx;
    // Remove default port
    containerWithoutPort.defaultPort = undefined;

    // Expect error when calling containerFetch without a port
    await expect(async () => {
      // @ts-ignore - ignore TypeScript errors for testing
      await containerWithoutPort.containerFetch(mockRequest);
    }).rejects.toThrow('No port specified for container fetch');
  });

  test('stop should signal container if running', async () => {
    // Make mockCtx.container.running true for this test
    mockCtx.container.running = true;

    // @ts-ignore - ignore TypeScript errors for testing
    await container.stop('SIGTERM');

    expect(mockCtx.container.signal).toHaveBeenCalledWith(15);
  });

  test('renewActivityTimeout should update the activity deadline', () => {
    const before = Date.now();

    container.renewActivityTimeout();

    expect((container as any).sleepAfterMs).toBeGreaterThan(before);
  });

  test('should renew activity timeout on fetch', async () => {
    // Setup spy on renewActivityTimeout
    // @ts-ignore - ignore TypeScript errors for testing
    const renewSpy = vi.spyOn(container, 'renewActivityTimeout');

    // Mock request
    const mockRequest = new Request('https://example.com/test');

    // Ensure container is running
    mockCtx.container.running = true;
    mockCtx.storage.get.mockResolvedValue({ status: 'healthy', lastChange: Date.now() });

    // @ts-ignore - ignore TypeScript errors for testing
    await container.fetch(mockRequest);

    // Check that renewActivityTimeout was called
    expect(renewSpy).toHaveBeenCalled();
  });

  test('containerFetch should create a WebSocket connection when requested', async () => {
    // Mock WebSocket upgrade request
    const mockRequest = new Request('https://example.com/ws', {
      headers: new Headers({
        Upgrade: 'websocket',
        Connection: 'Upgrade',
      }),
    });

    // Ensure container is running
    mockCtx.container.running = true;
    mockCtx.storage.get.mockResolvedValue({ status: 'healthy', lastChange: Date.now() });

    // @ts-ignore - ignore TypeScript errors for testing
    const response = await container.containerFetch(mockRequest);

    // Check TCP port fetch was called
    const tcpPort = mockCtx.container.getTcpPort.mock.results[0].value;
    expect(tcpPort.fetch).toHaveBeenCalled();

    const forwardedRequest = tcpPort.fetch.mock.calls[0][1] as Request;
    expect(forwardedRequest.headers.get('Upgrade')).toBe('websocket');
  });

  test('fetch should detect WebSocket requests and forward them correctly', async () => {
    // Setup spy on containerFetch
    // @ts-ignore - ignore TypeScript errors for testing
    const proxySpy = vi.spyOn(container, 'containerFetch');

    // Mock WebSocket upgrade request
    const mockRequest = new Request('https://example.com/ws', {
      headers: new Headers({
        Upgrade: 'websocket',
        Connection: 'Upgrade',
      }),
    });

    // Ensure container is running
    mockCtx.container.running = true;
    mockCtx.storage.get.mockResolvedValue({ status: 'healthy', lastChange: Date.now() });

    // Call fetch
    // @ts-ignore - ignore TypeScript errors for testing
    await container.fetch(mockRequest);

    // containerFetch should be called with the request and default port
    expect(proxySpy).toHaveBeenCalledWith(mockRequest, container.defaultPort);
  });
});

// Create load balance tests
describe('getRandom', () => {
  test('should return a container stub', async () => {
    const mockBinding = {
      idFromName: vi.fn().mockReturnValue('mock-id'),
      get: vi.fn().mockReturnValue({ mockStub: true }),
    };

    const result = await getRandom(mockBinding as any, 5);

    expect(mockBinding.idFromName).toHaveBeenCalled();
    expect(mockBinding.get).toHaveBeenCalledWith('mock-id');
    expect(result).toEqual({ mockStub: true });
  });
});
