// Mock partyserver first
jest.mock('partyserver');

import { Container } from '../lib/container';
import { getRandom } from '../lib/utils';

// Mock async hooks
jest.mock('node:async_hooks', () => {
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
        sql: {
          exec: jest.fn().mockReturnValue([]),
        },
      },
      blockConcurrencyWhile: jest.fn(fn => fn()),
      container: {
        running: false,
        start: jest.fn(),
        destroy: jest.fn(),
        monitor: jest.fn().mockReturnValue(Promise.resolve()),
        getTcpPort: jest.fn().mockReturnValue({
          fetch: jest.fn().mockImplementation((url, init) => {
            // Check if this is a WebSocket request
            if (init?.headers && (init.headers as Headers).get('Upgrade') === 'websocket') {
              // Create a mock WebSocket
              const mockWs = new (jest.requireMock('partyserver').MockWebSocket)();
              return Promise.resolve({
                status: 101,
                webSocket: mockWs,
              });
            }

            // Regular HTTP response
            return Promise.resolve({
              status: 200,
              body: 'test',
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
    expect(container.sleepAfter).toBe('5m');
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

  test('startAndWaitForPorts should start container without port checking if no ports available', async () => {
    // Create a container without defaultPort or requiredPorts
    // @ts-ignore - ignore TypeScript errors for testing
    const containerWithoutPort = new Container(mockCtx, {});
    // Add ctx property for testing
    (containerWithoutPort as any).ctx = mockCtx;

    // @ts-ignore - ignore TypeScript errors for testing
    await containerWithoutPort.startAndWaitForPorts();

    // Should start container
    expect(mockCtx.container.start).toHaveBeenCalled();
    // Should NOT try to get TCP port
    expect(mockCtx.container.getTcpPort).not.toHaveBeenCalled();
  });

  test('startAndWaitForPort (legacy) should call startAndWaitForPorts', async () => {
    // Create spy on startAndWaitForPorts
    const spy = jest.spyOn(container, 'startAndWaitForPorts');

    // Call the legacy method
    await container.startAndWaitForPort(8080);

    // Verify it called startAndWaitForPorts with the same parameters
    expect(spy).toHaveBeenCalledWith(8080, 10);
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

    // @ts-ignore - ignore TypeScript errors for testing
    await container.containerFetch(mockRequest);

    const tcpPort = mockCtx.container.getTcpPort.mock.results[0].value;
    expect(tcpPort.fetch).toHaveBeenCalled();

    // Just make sure that tcpPort.fetch was called - the exact URL is tested in the container.ts implementation
    expect(tcpPort.fetch).toHaveBeenCalledWith(expect.any(String), expect.any(Object));
  });

  test('containerFetch should throw error when no port is specified', async () => {
    const mockRequest = new Request('https://example.com/test', {
      method: 'GET',
    });

    // Make mockCtx.container.running true for this test
    mockCtx.container.running = true;

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

  test('stop should destroy container if running', async () => {
    // Make mockCtx.container.running true for this test
    mockCtx.container.running = true;

    // @ts-ignore - ignore TypeScript errors for testing
    await container.stop('Test stop');

    expect(mockCtx.container.destroy).toHaveBeenCalledWith('Test stop');
  });

  test('renewActivityTimeout should schedule a container timeout', async () => {
    // Make mockCtx.container.running true for this test
    mockCtx.container.running = true;

    // @ts-ignore - ignore TypeScript errors for testing
    await container.renewActivityTimeout();

    // Check that schedule was called
    expect((container as any).schedule).toHaveBeenCalled();

    // The first parameter should be the timeout in seconds
    // We need to handle both numeric and string formats
    const scheduleCall = (container as any).schedule.mock.calls[0];
    expect(scheduleCall[0]).toBeGreaterThan(0); // Should be a positive number
    expect(scheduleCall[1]).toBe('stopDueToInactivity'); // Method name
  });

  test('should renew activity timeout on fetch', async () => {
    // Setup spy on renewActivityTimeout
    // @ts-ignore - ignore TypeScript errors for testing
    const renewSpy = jest.spyOn(container, 'renewActivityTimeout');

    // Mock request
    const mockRequest = new Request('https://example.com/test');

    // Ensure container is running
    mockCtx.container.running = true;

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

    // @ts-ignore - ignore TypeScript errors for testing
    const response = await container.containerFetch(mockRequest);

    // Check TCP port fetch was called
    const tcpPort = mockCtx.container.getTcpPort.mock.results[0].value;
    expect(tcpPort.fetch).toHaveBeenCalled();

    // Verify the request was forwarded with WebSocket headers
    expect(tcpPort.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Upgrade: 'websocket',
        }),
      })
    );
  });

  test('fetch should detect WebSocket requests and forward them correctly', async () => {
    // Setup spy on containerFetch
    // @ts-ignore - ignore TypeScript errors for testing
    const proxySpy = jest.spyOn(container, 'containerFetch');

    // Mock WebSocket upgrade request
    const mockRequest = new Request('https://example.com/ws', {
      headers: new Headers({
        Upgrade: 'websocket',
        Connection: 'Upgrade',
      }),
    });

    // Ensure container is running
    mockCtx.container.running = true;

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
      idFromString: jest.fn().mockReturnValue('mock-id'),
      get: jest.fn().mockReturnValue({ mockStub: true }),
    };

    const result = await getRandom(mockBinding as any, 5);

    expect(mockBinding.idFromString).toHaveBeenCalled();
    expect(mockBinding.get).toHaveBeenCalledWith('mock-id');
    expect(result).toEqual({ mockStub: true });
  });
});

// Container Exec Tests
describe('Container Exec', () => {
  let mockCtx: any;
  let container: Container;

  beforeEach(() => {
    // Create a mock context with necessary container methods
    mockCtx = {
      storage: {
        sql: {
          exec: jest.fn().mockReturnValue([]),
        },
        put: jest.fn().mockResolvedValue(undefined),
        get: jest.fn().mockResolvedValue(undefined),
        setAlarm: jest.fn().mockResolvedValue(undefined),
        deleteAlarm: jest.fn().mockResolvedValue(undefined),
        sync: jest.fn().mockResolvedValue(undefined),
      },
      blockConcurrencyWhile: jest.fn(fn => fn()),
      container: {
        running: true,
        start: jest.fn(),
        destroy: jest.fn(),
        monitor: jest.fn().mockReturnValue(Promise.resolve()),
        getTcpPort: jest.fn().mockReturnValue({
          fetch: jest.fn(),
        }),
      },
    };

    // @ts-ignore - ignore TypeScript errors for testing
    container = new Container(mockCtx, {}, { defaultPort: 8080 });
  });

  test('should execute simple string command successfully', async () => {
    const mockExecResponse = {
      ok: true,
      json: jest.fn().mockResolvedValue({
        exitCode: 0,
        stdout: 'Hello World\n',
        stderr: '',
        duration: 100,
      }),
    };

    mockCtx.container.getTcpPort().fetch.mockResolvedValue(mockExecResponse);

    const result = await container.exec('echo "Hello World"');

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Hello World\n');
    expect(result.stderr).toBe('');
    expect(mockCtx.container.getTcpPort().fetch).toHaveBeenCalledWith(
      'http://container/__exec',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: ['/bin/sh', '-c', 'echo "Hello World"'],
          workingDirectory: undefined,
          env: undefined,
          timeout: 30000,
        }),
      })
    );
  });

  test('should execute array command successfully', async () => {
    const mockExecResponse = {
      ok: true,
      json: jest.fn().mockResolvedValue({
        exitCode: 0,
        stdout: 'file1.txt\nfile2.txt\n',
        stderr: '',
        duration: 150,
      }),
    };

    mockCtx.container.getTcpPort().fetch.mockResolvedValue(mockExecResponse);

    const result = await container.exec(['ls', '-la']);

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('file1.txt\nfile2.txt\n');
    expect(mockCtx.container.getTcpPort().fetch).toHaveBeenCalledWith(
      'http://container/__exec',
      expect.objectContaining({
        body: JSON.stringify({
          command: ['ls', '-la'],
          workingDirectory: undefined,
          env: undefined,
          timeout: 30000,
        }),
      })
    );
  });

  test('should execute command with options', async () => {
    const mockExecResponse = {
      ok: true,
      json: jest.fn().mockResolvedValue({
        exitCode: 0,
        stdout: 'production environment\n',
        stderr: '',
        duration: 200,
      }),
    };

    mockCtx.container.getTcpPort().fetch.mockResolvedValue(mockExecResponse);

    const result = await container.exec('echo $NODE_ENV', {
      workingDirectory: '/app',
      env: { NODE_ENV: 'production' },
      timeout: 5000,
    });

    expect(result.success).toBe(true);
    expect(mockCtx.container.getTcpPort().fetch).toHaveBeenCalledWith(
      'http://container/__exec',
      expect.objectContaining({
        body: JSON.stringify({
          command: ['/bin/sh', '-c', 'echo $NODE_ENV'],
          workingDirectory: '/app',
          env: { NODE_ENV: 'production' },
          timeout: 5000,
        }),
      })
    );
  });

  test('should handle command execution failure', async () => {
    const mockExecResponse = {
      ok: true,
      json: jest.fn().mockResolvedValue({
        exitCode: 1,
        stdout: '',
        stderr: 'command not found: nonexistentcommand\n',
        duration: 50,
      }),
    };

    mockCtx.container.getTcpPort().fetch.mockResolvedValue(mockExecResponse);

    const result = await container.exec('nonexistentcommand');

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('command not found: nonexistentcommand\n');
  });

  test('should handle HTTP request failure', async () => {
    mockCtx.container.getTcpPort().fetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    const result = await container.exec('echo test');

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Exec failed: Exec request failed: 500 Internal Server Error');
  });

  test('should handle network/connection errors', async () => {
    mockCtx.container.getTcpPort().fetch.mockRejectedValue(new Error('Connection refused'));

    const result = await container.exec('echo test');

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('Exec failed: Connection refused');
  });

  test('should handle timeout', async () => {
    // Mock a slow response that will be aborted
    mockCtx.container.getTcpPort().fetch.mockImplementation(() => 
      new Promise((resolve) => {
        setTimeout(resolve, 10000); // 10 second delay
      })
    );

    const result = await container.exec('sleep 10', { timeout: 100 });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(124); // Standard timeout exit code
    expect(result.stderr).toBe('Command timed out');
  });

  test('should handle abort signal', async () => {
    const controller = new AbortController();
    
    // Mock a slow response
    mockCtx.container.getTcpPort().fetch.mockImplementation(() => 
      new Promise((resolve, reject) => {
        setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 1000);
      })
    );

    // Abort after a short delay
    setTimeout(() => controller.abort(), 50);

    const result = await container.exec('sleep 5', { signal: controller.signal });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toBe('Command timed out');
  });

  test('should start container if not running', async () => {
    // Mock container as not running initially
    mockCtx.container.running = false;

    const mockExecResponse = {
      ok: true,
      json: jest.fn().mockResolvedValue({
        exitCode: 0,
        stdout: 'test output\n',
        stderr: '',
        duration: 100,
      }),
    };

    mockCtx.container.getTcpPort().fetch.mockResolvedValue(mockExecResponse);

    // Mock startAndWaitForPorts to start the container
    const startSpy = jest.spyOn(container, 'startAndWaitForPorts').mockResolvedValue();

    const result = await container.exec('echo test');

    expect(startSpy).toHaveBeenCalledWith({
      ports: 8080,
      cancellationOptions: { abort: undefined }
    });
    expect(result.success).toBe(true);
  });
});
