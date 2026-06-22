import { describe, expect, test as baseTest, vi } from 'vitest';
import { Container } from '../lib/container';
import { getRandom } from '../lib/utils';
import { MockWebSocket, test, webSocketPairSpy } from './fixtures';

describe('Container', () => {
  test('should initialize with default values', ({ container }) => {
    expect(container.defaultPort).toBe(8080);
    expect(container.sleepAfter).toBe('10m');
  });

  test('should use configured constructor startup options', async ({ mockCtx }) => {
    const container = new Container(
      mockCtx as never,
      {},
      {
        defaultPort: 8080,
        envVars: { MESSAGE: 'configured' },
        entrypoint: ['node', 'server.js'],
        enableInternet: false,
      }
    );

    await container.startAndWaitForPorts();

    expect(mockCtx.container.start).toHaveBeenCalledWith({
      enableInternet: false,
      env: { MESSAGE: 'configured' },
      entrypoint: ['node', 'server.js'],
    });
  });

  test('startAndWaitForPorts should start container if not running (single port)', async ({
    mockCtx,
    container,
  }) => {
    await container.startAndWaitForPorts(8080);

    expect(mockCtx.container.start).toHaveBeenCalled();
    expect(mockCtx.container.getTcpPort).toHaveBeenCalledWith(8080);
  });

  test('startAndWaitForPorts should check multiple ports if provided', async ({
    mockCtx,
    container,
  }) => {
    await container.startAndWaitForPorts([8080, 9090]);

    expect(mockCtx.container.start).toHaveBeenCalled();
    expect(mockCtx.container.getTcpPort).toHaveBeenCalledWith(8080);
    expect(mockCtx.container.getTcpPort).toHaveBeenCalledWith(9090);
  });

  test('startAndWaitForPorts should use requiredPorts if defined and no ports specified', async ({
    mockCtx,
    container,
  }) => {
    container.requiredPorts = [3000, 4000];

    await container.startAndWaitForPorts();

    expect(mockCtx.container.start).toHaveBeenCalled();
    expect(mockCtx.container.getTcpPort).toHaveBeenCalledWith(3000);
    expect(mockCtx.container.getTcpPort).toHaveBeenCalledWith(4000);
  });

  test('startAndWaitForPorts should use defaultPort if no ports specified and no requiredPorts', async ({
    mockCtx,
    container,
  }) => {
    await container.startAndWaitForPorts();

    expect(mockCtx.container.start).toHaveBeenCalled();
    expect(mockCtx.container.getTcpPort).toHaveBeenCalledWith(8080);
  });

  test('startAndWaitForPorts should recognise local-dev "not listening" error without leading "the"', async ({
    mockCtx,
    container,
  }) => {
    // In local dev (wrangler dev) the runtime returns "container is not listening"
    // without the leading "the" that production uses. Both variants must be
    // recognised so doStartContainer treats the state as benign and returns
    // instead of retrying until timeout.
    const localDevError = new Error('container is not listening on TCP address 10.0.0.1:8080');
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(localDevError)
      .mockResolvedValue(new Response('ok'));
    mockCtx.container.getTcpPort.mockReturnValue({ fetch: fetchMock });

    await container.startAndWaitForPorts(8080);

    expect(mockCtx.container.getTcpPort).toHaveBeenCalledWith(8080);
    // Exactly 2 calls: doStartContainer recognises the error and returns
    // immediately (1 call), then waitForPort succeeds on its first attempt
    // (1 call). Without the fix the error is not recognised, doStartContainer
    // retries, and the count rises to 3+.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('startAndWaitForPorts should surface rate-limited startup errors on the final retry', async ({
    mockCtx,
    container,
  }) => {
    using onErrorSpy = vi.spyOn(container, 'onError').mockImplementation(error => {
      throw error;
    });

    mockCtx.container.monitor.mockReturnValue({
      catch: vi
        .fn()
        .mockResolvedValue(new Error('you are requesting too many containers per second')),
    } as unknown as Promise<unknown>);
    mockCtx.container.getTcpPort.mockReturnValue({
      fetch: vi.fn().mockRejectedValue(new Error('unexpected startup failure')),
    });

    await expect(
      container.startAndWaitForPorts({
        ports: 8080,
        cancellationOptions: { instanceGetTimeoutMS: 1, waitInterval: 1 },
      })
    ).rejects.toThrow('you are requesting too many containers per second');
    expect(onErrorSpy).toHaveBeenCalled();
    expect(mockCtx.storage.put).toHaveBeenCalledWith(
      '__CF_CONTAINER_STATE',
      expect.objectContaining({ status: 'stopped' })
    );
  });

  test('startAndWaitForPorts should abort the durable object on final network loss', async ({
    mockCtx,
    container,
  }) => {
    mockCtx.container.monitor.mockReturnValue({
      catch: vi
        .fn()
        .mockResolvedValue(
          new Error('there is no container instance that can be provided to this durable object')
        ),
    } as unknown as Promise<unknown>);
    mockCtx.container.getTcpPort.mockReturnValue({
      fetch: vi.fn().mockRejectedValue(new Error('Network connection lost')),
    });

    await expect(
      container.startAndWaitForPorts({
        ports: 8080,
        cancellationOptions: { instanceGetTimeoutMS: 1, waitInterval: 1 },
      })
    ).rejects.toThrow('there is no container instance that can be provided to this durable object');

    expect(mockCtx.abort).toHaveBeenCalled();
    expect(mockCtx.storage.put).toHaveBeenCalledWith(
      '__CF_CONTAINER_STATE',
      expect.objectContaining({ status: 'stopped' })
    );
  });

  test('monitor should clear running state when an instance becomes unavailable', async ({
    mockCtx,
    container,
  }) => {
    let rejectMonitor: (error: Error) => void = () => undefined;
    mockCtx.container.monitor.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectMonitor = reject;
      })
    );

    await container.start(undefined, { portToCheck: 8080, retries: 1, waitInterval: 1 });
    rejectMonitor(
      new Error('there is no container instance that can be provided to this durable object')
    );

    await vi.waitFor(() => {
      expect(mockCtx.storage.put).toHaveBeenCalledWith(
        '__CF_CONTAINER_STATE',
        expect.objectContaining({ status: 'stopped' })
      );
    });
  });

  test('monitor should clear running state before reporting a terminal error', async ({
    mockCtx,
    container,
  }) => {
    let rejectMonitor: (error: Error) => void = () => undefined;
    using onErrorSpy = vi.spyOn(container, 'onError').mockResolvedValue(undefined);
    mockCtx.container.monitor.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectMonitor = reject;
      })
    );

    await container.start(undefined, { portToCheck: 8080, retries: 1, waitInterval: 1 });
    rejectMonitor(new Error('container supervisor failed'));

    await vi.waitFor(() => {
      expect(mockCtx.storage.put).toHaveBeenCalledWith(
        '__CF_CONTAINER_STATE',
        expect.objectContaining({ status: 'stopped' })
      );
      expect(onErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'container supervisor failed' })
      );
    });
  });

  test('replaced monitor should not stop a newer container instance', async ({
    mockCtx,
    container,
  }) => {
    let resolveFirstMonitor: () => void = () => undefined;
    mockCtx.container.monitor
      .mockReturnValueOnce(
        new Promise(resolve => {
          resolveFirstMonitor = resolve;
        })
      )
      .mockReturnValueOnce(new Promise(() => undefined));

    await container.start(undefined, { portToCheck: 8080, retries: 1, waitInterval: 1 });
    mockCtx.container.running = false;
    await container.start(undefined, { portToCheck: 8080, retries: 1, waitInterval: 1 });
    resolveFirstMonitor();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockCtx.storage.put).not.toHaveBeenCalledWith(
      '__CF_CONTAINER_STATE',
      expect.objectContaining({ status: 'stopped_with_code' })
    );
  });

  test('startAndWaitForPorts should fall back to default health check port', async ({
    mockCtx,
  }) => {
    // @ts-expect-error - mockCtx isn't a real DurableObjectState
    const containerWithoutPort = new Container(mockCtx, {});

    await containerWithoutPort.startAndWaitForPorts();

    expect(mockCtx.container.start).toHaveBeenCalled();
    expect(mockCtx.container.getTcpPort).toHaveBeenCalledWith(33);
  });

  test('alarm should not stop a container while its start loop is in flight', async ({
    mockCtx,
    container,
  }) => {
    let resumeStart: () => void = () => undefined;
    const startBlockedBeforePhysicalStart = new Promise<void>(resolve => {
      resumeStart = resolve;
    });
    vi.spyOn(container, 'scheduleNextAlarm').mockImplementationOnce(
      () => startBlockedBeforePhysicalStart
    );
    using onStopSpy = vi.spyOn(container, 'onStop');

    const startPromise = container.start(undefined, {
      portToCheck: 8080,
      retries: 1,
      waitInterval: 1,
    });
    await vi.waitFor(() => {
      expect(container.scheduleNextAlarm).toHaveBeenCalled();
    });
    expect(mockCtx.container.start).not.toHaveBeenCalled();

    await container.alarm();
    resumeStart();
    await startPromise;

    expect(onStopSpy).not.toHaveBeenCalled();
    await expect(container.getState()).resolves.toEqual(
      expect.objectContaining({ status: 'running' })
    );
  });

  test('syncPendingStoppedEvents should call onStop for stopped container with running state', async ({
    mockCtx,
    container,
  }) => {
    mockCtx.storage.get.mockResolvedValue({ status: 'running', lastChange: Date.now() });
    mockCtx.container.running = false;
    using onStopSpy = vi.spyOn(container, 'onStop');

    // @ts-expect-error - syncPendingStoppedEvents is private
    await container.syncPendingStoppedEvents();

    expect(onStopSpy).toHaveBeenCalledWith({ exitCode: 0, reason: 'exit' });
    expect(mockCtx.storage.put).toHaveBeenCalledWith(
      '__CF_CONTAINER_STATE',
      expect.objectContaining({ status: 'stopped' })
    );
  });

  test('onStop starting a new container should not overwrite its running state', async ({
    mockCtx,
    container,
  }) => {
    mockCtx.storage.get.mockResolvedValue({ status: 'running', lastChange: Date.now() });
    mockCtx.container.running = false;
    vi.spyOn(container, 'onStop').mockImplementation(async () => {
      await container.start(undefined, { portToCheck: 8080, retries: 1, waitInterval: 1 });
    });

    await (
      container as unknown as { syncPendingStoppedEvents(): Promise<void> }
    ).syncPendingStoppedEvents();

    expect(mockCtx.container.running).toBe(true);
    await expect(container.getState()).resolves.toEqual(
      expect.objectContaining({ status: 'running' })
    );
  });

  test('containerFetch should forward requests to container', async ({ mockCtx, container }) => {
    const mockRequest = new Request('https://example.com/test?query=value', {
      method: 'GET',
      headers: new Headers({
        'Content-Type': 'application/json',
      }),
    });

    mockCtx.container.running = true;
    mockCtx.storage.get.mockResolvedValue({ status: 'healthy', lastChange: Date.now() });

    await container.containerFetch(mockRequest);

    const tcpPort = mockCtx.container.getTcpPort.mock.results[0].value;
    expect(tcpPort.fetch).toHaveBeenCalled();

    // Just make sure that tcpPort.fetch was called - the exact URL is tested in the container.ts implementation
    expect(tcpPort.fetch).toHaveBeenCalledWith(expect.any(String), expect.any(Object));
  });

  test('containerFetch should return 429 when startup is rate limited', async ({ container }) => {
    const mockRequest = new Request('https://example.com/test', { method: 'GET' });
    using startSpy = vi
      .spyOn(container, 'startAndWaitForPorts')
      .mockRejectedValue(new Error('you are requesting too many containers per second'));

    const response = await container.containerFetch(mockRequest);

    expect(startSpy).toHaveBeenCalledWith(8080, { abort: mockRequest.signal });
    expect(response.status).toBe(429);
    await expect(response.text()).resolves.toBe(
      'you are requesting too many containers per second'
    );
  });

  test('containerFetch should throw error when no port is specified', async ({ mockCtx }) => {
    const mockRequest = new Request('https://example.com/test', {
      method: 'GET',
    });

    mockCtx.container.running = true;
    mockCtx.storage.get.mockResolvedValue({ status: 'healthy', lastChange: Date.now() });

    // @ts-expect-error - mockCtx isn't a real DurableObjectState
    const containerWithoutPort = new Container(mockCtx, {});
    containerWithoutPort.defaultPort = undefined;

    await expect(containerWithoutPort.containerFetch(mockRequest)).rejects.toThrow(
      'No port specified for container fetch'
    );
  });

  test('stop should signal container if running', async ({ mockCtx, container }) => {
    mockCtx.container.running = true;

    await container.stop('SIGTERM');

    expect(mockCtx.container.signal).toHaveBeenCalledWith(15);
  });

  test('renewActivityTimeout should update the activity deadline', ({ container }) => {
    const before = Date.now();

    container.renewActivityTimeout();

    // @ts-expect-error - sleepAfterMs is private
    expect(container.sleepAfterMs).toBeGreaterThan(before);
  });

  test('should renew activity timeout on fetch', async ({ mockCtx, container }) => {
    using renewSpy = vi.spyOn(container, 'renewActivityTimeout');

    const mockRequest = new Request('https://example.com/test');

    mockCtx.container.running = true;
    mockCtx.storage.get.mockResolvedValue({ status: 'healthy', lastChange: Date.now() });

    await container.fetch(mockRequest);

    expect(renewSpy).toHaveBeenCalled();
  });

  test('containerFetch should create a WebSocket connection when requested', async ({
    mockCtx,
    container,
  }) => {
    const mockRequest = new Request('https://example.com/ws', {
      headers: new Headers({
        Upgrade: 'websocket',
        Connection: 'Upgrade',
      }),
    });

    mockCtx.container.running = true;
    mockCtx.storage.get.mockResolvedValue({ status: 'healthy', lastChange: Date.now() });

    const response = await container.containerFetch(mockRequest);

    const tcpPort = mockCtx.container.getTcpPort.mock.results[0].value;
    expect(tcpPort.fetch).toHaveBeenCalled();

    const forwardedRequest = tcpPort.fetch.mock.calls[0][1] as Request;
    expect(forwardedRequest.headers.get('Upgrade')).toBe('websocket');

    // The WebSocket branch must have been taken. If `WebSocketPair` is missing
    // from the global scope, `containerFetch` catches the ReferenceError and
    // returns a 500 — these assertions guard against that silent regression.
    expect(webSocketPairSpy).toHaveBeenCalledOnce();

    // Container-side WebSocket from the tcpPort response must be accepted
    // and wired up with message/close/error handlers.
    const containerWs = (await tcpPort.fetch.mock.results[0].value).webSocket as MockWebSocket;
    expect(containerWs.accept).toHaveBeenCalledOnce();
    expect(containerWs.eventListeners.message).toHaveLength(1);
    expect(containerWs.eventListeners.close).toHaveLength(1);
    expect(containerWs.eventListeners.error).toHaveLength(1);

    // The response must carry the upstream status (200 in our mock) and the
    // headers from the tcpPort response. The `webSocket` property does not
    // survive Node's Response constructor, but in workerd it would be the
    // client-side socket of the pair.
    expect(response.status).toBe(200);
  });

  test('fetch should detect WebSocket requests and forward them correctly', async ({
    mockCtx,
    container,
  }) => {
    using proxySpy = vi.spyOn(container, 'containerFetch');

    const mockRequest = new Request('https://example.com/ws', {
      headers: new Headers({
        Upgrade: 'websocket',
        Connection: 'Upgrade',
      }),
    });

    mockCtx.container.running = true;
    mockCtx.storage.get.mockResolvedValue({ status: 'healthy', lastChange: Date.now() });

    await container.fetch(mockRequest);

    expect(proxySpy).toHaveBeenCalledWith(mockRequest, container.defaultPort);
  });
});

describe('getRandom', () => {
  baseTest('should return a container stub', async () => {
    const mockBinding = {
      idFromName: vi.fn<(name: string) => string>().mockReturnValue('mock-id'),
      get: vi.fn<(id: string) => { mockStub: boolean }>().mockReturnValue({ mockStub: true }),
    };

    const result = await getRandom(mockBinding as unknown as Parameters<typeof getRandom>[0], 5);

    expect(mockBinding.idFromName).toHaveBeenCalled();
    expect(mockBinding.get).toHaveBeenCalledWith('mock-id');
    expect(result).toEqual({ mockStub: true });
  });
});
