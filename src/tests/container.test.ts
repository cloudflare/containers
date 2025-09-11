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

  // ==========================
  //     CHECKPOINT TESTS
  // ==========================

  describe('Checkpoint functionality', () => {
    beforeEach(() => {
      // Reset mocks
      jest.clearAllMocks();
      
      // Make container healthy for checkpoint tests
      mockCtx.container.running = true;
      (container as any).state = {
        getState: jest.fn().mockResolvedValue({ status: 'healthy' })
      };
      
      // Mock containerFetch for checkpoint endpoints
      jest.spyOn(container, 'containerFetch').mockImplementation(async (url, options) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        
        if (urlStr.includes('/__checkpoint')) {
          return new Response(JSON.stringify({ sizeBytes: 1024000 }), { 
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        
        if (urlStr.includes('/__restore')) {
          return new Response(JSON.stringify({ sizeBytes: 1024000 }), { 
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        
        if (urlStr.includes('/__delete-checkpoint')) {
          return new Response('', { status: 200 });
        }
        
        return new Response('OK', { status: 200 });
      });
    });

    test('checkpoint() should create a checkpoint with auto-generated name', async () => {
      const result = await container.checkpoint();
      
      expect(result).toHaveProperty('checkpointId');
      expect(result).toHaveProperty('r2Path');
      expect(result).toHaveProperty('createdAt');
      expect(result).toHaveProperty('sizeBytes', 1024000);
      expect(result).toHaveProperty('checkpointedPath', '/');
      
      // Verify checkpointId format: ContainerName-id-timestamp
      expect(result.checkpointId).toMatch(/^Container-.*-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
      
      // Verify R2 path structure
      expect(result.r2Path).toMatch(/^container-checkpoints\/Container\/.+\/container-snapshot-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
    });

    test('checkpoint() should create a checkpoint for specific path', async () => {
      const result = await container.checkpoint({ path: '/app' });
      
      expect(result.checkpointedPath).toBe('/app');
      expect(container.containerFetch).toHaveBeenCalledWith(
        '/__checkpoint',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"sourcePath":"/app"')
        })
      );
    });

    test('checkpoint() should use custom timeout when provided', async () => {
      await container.checkpoint({ timeoutSeconds: 600 });
      
      expect(container.containerFetch).toHaveBeenCalledWith(
        '/__checkpoint',
        expect.objectContaining({
          body: expect.stringContaining('"timeoutSeconds":600')
        })
      );
    });

    test('checkpoint() should throw error when container is not healthy', async () => {
      (container as any).state.getState.mockResolvedValue({ status: 'stopped' });
      
      await expect(container.checkpoint()).rejects.toThrow(
        'Container must be running to create a checkpoint'
      );
    });

    test('checkpoint() should handle container fetch errors', async () => {
      jest.spyOn(container, 'containerFetch').mockRejectedValue(
        new Error('Container unavailable')
      );
      
      await expect(container.checkpoint()).rejects.toThrow();
    });

    test('restore() should restore from checkpoint', async () => {
      // Setup checkpoint info mock
      const checkpointInfo = {
        checkpointId: 'test-checkpoint-123',
        r2Path: 'container-checkpoints/Container/123/container-snapshot-2023-12-01T10-30-00',
        createdAt: new Date('2023-12-01T10:30:00Z'),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 1 week from now
        sizeBytes: 1024000,
        originalPath: '/app'
      };
      
      jest.spyOn(container as any, 'getCheckpointInfo').mockResolvedValue(checkpointInfo);
      jest.spyOn(container as any, 'waitForStop').mockResolvedValue(undefined);
      jest.spyOn(container, 'stop').mockResolvedValue(undefined);
      jest.spyOn(container, 'start').mockResolvedValue(undefined);
      jest.spyOn(container, 'startAndWaitForPorts').mockResolvedValue(undefined);
      
      const result = await container.restore({ checkpointId: 'test-checkpoint-123' });
      
      expect(result).toHaveProperty('checkpointId', 'test-checkpoint-123');
      expect(result).toHaveProperty('restoredPath', '/app');
      expect(result).toHaveProperty('restoredSizeBytes', 1024000);
      expect(result).toHaveProperty('restoredAt');
      
      // Verify restore flow: stop -> start -> restore -> restart
      expect(container.stop).toHaveBeenCalled();
      expect(container.start).toHaveBeenCalled();
      expect(container.startAndWaitForPorts).toHaveBeenCalled();
      
      expect(container.containerFetch).toHaveBeenCalledWith(
        '/__restore',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('test-checkpoint-123')
        })
      );
    });

    test('restore() should not restart container when startAfterRestore is false', async () => {
      const checkpointInfo = {
        checkpointId: 'test-checkpoint-123',
        r2Path: 'container-checkpoints/Container/123/container-snapshot-2023-12-01T10-30-00',
        createdAt: new Date('2023-12-01T10:30:00Z'),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        sizeBytes: 1024000,
        originalPath: '/app'
      };
      
      jest.spyOn(container as any, 'getCheckpointInfo').mockResolvedValue(checkpointInfo);
      jest.spyOn(container as any, 'waitForStop').mockResolvedValue(undefined);
      jest.spyOn(container, 'stop').mockResolvedValue(undefined);
      jest.spyOn(container, 'start').mockResolvedValue(undefined);
      jest.spyOn(container, 'startAndWaitForPorts').mockResolvedValue(undefined);
      
      await container.restore({ 
        checkpointId: 'test-checkpoint-123',
        startAfterRestore: false 
      });
      
      // Should not restart after restore
      expect(container.startAndWaitForPorts).not.toHaveBeenCalled();
    });

    test('restore() should throw error for non-existent checkpoint', async () => {
      jest.spyOn(container as any, 'getCheckpointInfo').mockResolvedValue(null);
      
      await expect(container.restore({ checkpointId: 'non-existent' })).rejects.toThrow(
        'Checkpoint non-existent not found'
      );
    });

    test('restore() should throw error for expired checkpoint', async () => {
      const expiredCheckpoint = {
        checkpointId: 'expired-checkpoint',
        r2Path: 'container-checkpoints/Container/123/old-snapshot',
        createdAt: new Date('2023-01-01T00:00:00Z'),
        expiresAt: new Date('2023-01-15T00:00:00Z'), // Past date
        sizeBytes: 1024000,
        originalPath: '/app'
      };
      
      jest.spyOn(container as any, 'getCheckpointInfo').mockResolvedValue(expiredCheckpoint);
      
      await expect(container.restore({ checkpointId: 'expired-checkpoint' })).rejects.toThrow(
        'Checkpoint expired-checkpoint has expired'
      );
    });

    test('listCheckpoints() should return array of checkpoint info', async () => {
      const mockCheckpoints = [{
        checkpoint_id: 'checkpoint-1',
        r2_path: 'container-checkpoints/Container/123/snapshot-1',
        created_at: Date.now() - (3 * 24 * 60 * 60 * 1000), // 3 days ago
        size_bytes: 1024000,
        original_path: '/app'
      }, {
        checkpoint_id: 'checkpoint-2',
        r2_path: 'container-checkpoints/Container/123/snapshot-2',
        created_at: Date.now() - (1 * 24 * 60 * 60 * 1000), // 1 day ago
        size_bytes: 2048000,
        original_path: '/data'
      }];
      
      mockCtx.storage.sql.exec.mockReturnValue(mockCheckpoints);
      
      const result = await container.listCheckpoints();
      
      expect(result).toHaveLength(2);
      expect(result[0]).toHaveProperty('checkpointId', 'checkpoint-1');
      expect(result[0]).toHaveProperty('r2Path', 'container-checkpoints/Container/123/snapshot-1');
      expect(result[0]).toHaveProperty('sizeBytes', 1024000);
      expect(result[0]).toHaveProperty('originalPath', '/app');
      expect(result[0]).toHaveProperty('expiresAt');
    });

    test('deleteCheckpoint() should delete checkpoint and return true', async () => {
      const checkpointInfo = {
        checkpointId: 'test-checkpoint',
        r2Path: 'container-checkpoints/Container/123/test-snapshot',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        sizeBytes: 1024000,
        originalPath: '/app'
      };
      
      jest.spyOn(container as any, 'getCheckpointInfo').mockResolvedValue(checkpointInfo);
      
      const result = await container.deleteCheckpoint('test-checkpoint');
      
      expect(result).toBe(true);
      expect(container.containerFetch).toHaveBeenCalledWith(
        '/__delete-checkpoint',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('test-snapshot')
        })
      );
    });

    test('deleteCheckpoint() should return false for non-existent checkpoint', async () => {
      jest.spyOn(container as any, 'getCheckpointInfo').mockResolvedValue(null);
      
      const result = await container.deleteCheckpoint('non-existent');
      
      expect(result).toBe(false);
    });

    test('cleanupExpiredCheckpoints() should delete expired checkpoints', async () => {
      const twoWeeksAgo = Date.now() - (15 * 24 * 60 * 60 * 1000); // 15 days ago
      const expiredCheckpoints = [{
        checkpoint_id: 'expired-1',
        r2_path: 'container-checkpoints/Container/123/expired-1'
      }, {
        checkpoint_id: 'expired-2',
        r2_path: 'container-checkpoints/Container/123/expired-2'
      }];
      
      mockCtx.storage.sql.exec.mockReturnValue(expiredCheckpoints);
      
      const deletedCount = await container.cleanupExpiredCheckpoints();
      
      expect(deletedCount).toBe(2);
      expect(container.containerFetch).toHaveBeenCalledTimes(2);
    });

    test('checkpoint endpoint communication should handle timeouts', async () => {
      jest.spyOn(container, 'containerFetch').mockRejectedValue(
        Object.assign(new Error('Timeout'), { name: 'TimeoutError' })
      );
      
      await expect(container.checkpoint({ timeoutSeconds: 5 })).rejects.toThrow(
        'Checkpoint operation timed out after 5 seconds'
      );
    });
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
