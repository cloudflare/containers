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
        setAlarm: jest.fn().mockResolvedValue(undefined),
        sync: jest.fn().mockResolvedValue(undefined),
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

  test('startAndWaitForPorts should work with legacy single port calls', async () => {
    // @ts-ignore - ignore TypeScript errors for testing
    await container.startAndWaitForPorts(8080);

    expect(mockCtx.container.start).toHaveBeenCalled();
    expect(mockCtx.container.getTcpPort).toHaveBeenCalledWith(8080);
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

// Secrets Store Bindings Tests
describe('Secrets Store Bindings', () => {
  let mockCtx: any;
  let container: Container;

  beforeEach(() => {
    // Create a mock context with necessary container methods
    mockCtx = {
      storage: {
        sql: {
          exec: jest.fn().mockReturnValue([]),
        },
        setAlarm: jest.fn().mockResolvedValue(undefined),
        sync: jest.fn().mockResolvedValue(undefined),
      },
      blockConcurrencyWhile: jest.fn(fn => fn()),
      container: {
        running: false,
        start: jest.fn(),
        destroy: jest.fn(),
        monitor: jest.fn().mockReturnValue(Promise.resolve()),
        getTcpPort: jest.fn().mockReturnValue({
          fetch: jest.fn().mockResolvedValue({
            status: 200,
            body: 'test',
          }),
        }),
      },
    };
  });

  test('should initialize with secretsStoreBindings from constructor options', () => {
    const secretsStoreBindings = [
      {
        binding: 'API_SECRETS',
        storeId: 'my-app-secrets',
        secretName: 'api-secrets'
      }
    ];

    // @ts-ignore - ignore TypeScript errors for testing
    const testContainer = new Container(mockCtx, {}, { secretsStoreBindings });
    (testContainer as any).ctx = mockCtx;

    expect(testContainer.secretsStoreBindings).toEqual(secretsStoreBindings);
  });

  test('should generate correct Secrets Store environment variables', () => {
    const secretsStoreBindings = [
      {
        binding: 'API_SECRETS',
        storeId: 'my-app-secrets',
        secretName: 'api-secrets'
      },
      {
        binding: 'DB-CREDENTIALS',
        storeId: 'db-store',
        secretName: 'database-password'
      }
    ];

    // @ts-ignore - ignore TypeScript errors for testing
    const testContainer = new Container(mockCtx, {}, { secretsStoreBindings });
    (testContainer as any).ctx = mockCtx;

    const envVars = (testContainer as any).setupSecretsStoreBindingEnvironment();

    expect(envVars).toEqual({
      'SECRETS_API_SECRETS_BINDING': 'API_SECRETS',
      'SECRETS_API_SECRETS_STORE_ID': 'my-app-secrets',
      'SECRETS_API_SECRETS_SECRET_NAME': 'api-secrets',
      'SECRETS_DB_CREDENTIALS_BINDING': 'DB-CREDENTIALS',
      'SECRETS_DB_CREDENTIALS_STORE_ID': 'db-store',
      'SECRETS_DB_CREDENTIALS_SECRET_NAME': 'database-password'
    });
  });

  test('should sanitize binding names for environment variables', () => {
    const secretsStoreBindings = [
      {
        binding: 'my-api@secrets!',
        storeId: 'test-store',
        secretName: 'test-secret'
      }
    ];

    // @ts-ignore - ignore TypeScript errors for testing
    const testContainer = new Container(mockCtx, {}, { secretsStoreBindings });
    (testContainer as any).ctx = mockCtx;

    const envVars = (testContainer as any).setupSecretsStoreBindingEnvironment();

    expect(envVars).toEqual({
      'SECRETS_MY_API_SECRETS__BINDING': 'my-api@secrets!',
      'SECRETS_MY_API_SECRETS__STORE_ID': 'test-store', 
      'SECRETS_MY_API_SECRETS__SECRET_NAME': 'test-secret'
    });
  });

  test('should merge Secrets Store environment variables with existing env vars during container start', async () => {
    const secretsStoreBindings = [
      {
        binding: 'API_SECRETS',
        storeId: 'my-app-secrets',
        secretName: 'api-secrets'
      }
    ];

    // @ts-ignore - ignore TypeScript errors for testing
    const testContainer = new Container(mockCtx, {}, { secretsStoreBindings });
    (testContainer as any).ctx = mockCtx;
    testContainer.defaultPort = 8080;

    // Mock the private method call to test environment merging
    const startSpy = jest.spyOn(mockCtx.container, 'start');

    // @ts-ignore - ignore TypeScript errors for testing
    await testContainer.startAndWaitForPorts(8080);

    expect(startSpy).toHaveBeenCalled();
    const startConfig: any = startSpy.mock.calls[0][0];
    
    expect(startConfig.env).toEqual(
      expect.objectContaining({
        'SECRETS_API_SECRETS_BINDING': 'API_SECRETS',
        'SECRETS_API_SECRETS_STORE_ID': 'my-app-secrets',
        'SECRETS_API_SECRETS_SECRET_NAME': 'api-secrets'
      })
    );
  });

  test('should handle empty secretsStoreBindings array', () => {
    // @ts-ignore - ignore TypeScript errors for testing
    const testContainer = new Container(mockCtx, {}, { secretsStoreBindings: [] });
    (testContainer as any).ctx = mockCtx;

    expect(testContainer.secretsStoreBindings).toEqual([]);
    
    const envVars = (testContainer as any).setupSecretsStoreBindingEnvironment();
    expect(envVars).toEqual({});
  });

  test('should provide Secrets Store binding info via getSecretsStoreBindingInfo', () => {
    const secretsStoreBindings = [
      {
        binding: 'API_SECRETS',
        storeId: 'my-app-secrets',
        secretName: 'api-secrets'
      }
    ];

    // @ts-ignore - ignore TypeScript errors for testing
    const testContainer = new Container(mockCtx, {}, { secretsStoreBindings });
    (testContainer as any).ctx = mockCtx;

    const info = testContainer.getSecretsStoreBindingInfo();

    expect(info).toEqual({
      'API_SECRETS': {
        binding: 'API_SECRETS',
        storeId: 'my-app-secrets',
        secretName: 'api-secrets',
        envVars: {
          'SECRETS_API_SECRETS_BINDING': 'API_SECRETS',
          'SECRETS_API_SECRETS_STORE_ID': 'my-app-secrets',
          'SECRETS_API_SECRETS_SECRET_NAME': 'api-secrets'
        }
      }
    });
  });

  test('should provide Secrets Store binding summary via getSecretsStoreBindingSummary', () => {
    const secretsStoreBindings = [
      {
        binding: 'API_SECRETS',
        storeId: 'my-app-secrets',
        secretName: 'api-secrets'
      },
      {
        binding: 'DB_CREDS',
        storeId: 'db-store',
        secretName: 'database-password'
      }
    ];

    // @ts-ignore - ignore TypeScript errors for testing
    const testContainer = new Container(mockCtx, {}, { secretsStoreBindings });
    (testContainer as any).ctx = mockCtx;

    const summary = testContainer.getSecretsStoreBindingSummary();

    expect(summary).toEqual({
      configured: 2,
      bindings: [
        {
          name: 'API_SECRETS',
          storeId: 'my-app-secrets',
          secretName: 'api-secrets'
        },
        {
          name: 'DB_CREDS',
          storeId: 'db-store',
          secretName: 'database-password'
        }
      ]
    });
  });

  test('should validate Secrets Store binding environment variables', () => {
    const secretsStoreBindings = [
      {
        binding: 'API_SECRETS',
        storeId: 'my-app-secrets',
        secretName: 'api-secrets'
      }
    ];

    // Mock environment variables
    const originalEnv = process.env;
    process.env = {
      ...originalEnv,
      'SECRETS_API_SECRETS_BINDING': 'API_SECRETS',
      'SECRETS_API_SECRETS_STORE_ID': 'my-app-secrets',
      'SECRETS_API_SECRETS_SECRET_NAME': 'api-secrets'
    };

    try {
      // @ts-ignore - ignore TypeScript errors for testing
      const testContainer = new Container(mockCtx, {}, { secretsStoreBindings });
      (testContainer as any).ctx = mockCtx;

      const validation = testContainer.validateSecretsStoreBindingEnvironment();

      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);
      expect(validation.bindings['API_SECRETS'].valid).toBe(true);
    } finally {
      process.env = originalEnv;
    }
  });

  test('should auto-detect Secrets Store bindings from environment', () => {
    const mockEnv = {
      API_SECRETS: {
        get: jest.fn()
      },
      DATABASE_CREDS: {
        get: jest.fn()
      },
      NOT_A_SECRET: 'just a string',
      ANOTHER_OBJECT: {
        someMethod: jest.fn() // doesn't have get method
      }
    };

    // @ts-ignore - ignore TypeScript errors for testing
    const testContainer = new Container(mockCtx, mockEnv);
    (testContainer as any).ctx = mockCtx;

    expect(testContainer.secretsStoreBindings).toEqual([
      {
        binding: 'API_SECRETS',
        storeId: 'auto-detected-store-api_secrets',
        secretName: 'api-secrets'
      },
      {
        binding: 'DATABASE_CREDS',
        storeId: 'auto-detected-store-database_creds',
        secretName: 'database-creds'
      }
    ]);
  });

  test('should auto-detect Secrets Store bindings with underscore to dash conversion', () => {
    const mockEnv = {
      MY_API_SECRETS: {
        get: jest.fn()
      }
    };

    // @ts-ignore - ignore TypeScript errors for testing
    const testContainer = new Container(mockCtx, mockEnv);
    (testContainer as any).ctx = mockCtx;

    expect(testContainer.secretsStoreBindings).toEqual([
      {
        binding: 'MY_API_SECRETS',
        storeId: 'auto-detected-store-my_api_secrets',
        secretName: 'my-api-secrets'
      }
    ]);
  });

  test('should not detect non-Secrets Store objects as Secrets Store bindings', () => {
    const mockEnv = {
      REGULAR_STRING: 'not a binding',
      SOME_OBJECT: {
        someProperty: 'value',
        someMethod: jest.fn()
      },
      NULL_VALUE: null,
      UNDEFINED_VALUE: undefined
    };

    // @ts-ignore - ignore TypeScript errors for testing
    const testContainer = new Container(mockCtx, mockEnv);
    (testContainer as any).ctx = mockCtx;

    expect(testContainer.secretsStoreBindings).toEqual([]);
  });

  test('should use auto-detected Secrets Store bindings during container construction', () => {
    const mockEnv = {
      API_SECRETS: {
        get: jest.fn()
      }
    };

    // @ts-ignore - ignore TypeScript errors for testing
    const testContainer = new Container(mockCtx, mockEnv);
    (testContainer as any).ctx = mockCtx;

    expect(testContainer.secretsStoreBindings.length).toBe(1);
    expect(testContainer.secretsStoreBindings[0].binding).toBe('API_SECRETS');
  });

  test('should prefer explicit secretsStoreBindings over auto-detection', () => {
    const mockEnv = {
      API_SECRETS: {
        get: jest.fn()
      },
      ANOTHER_SECRET: {
        get: jest.fn()
      }
    };

    const explicitBindings = [
      {
        binding: 'CUSTOM_SECRET',
        storeId: 'custom-store',
        secretName: 'custom-secret'
      }
    ];

    // @ts-ignore - ignore TypeScript errors for testing
    const testContainer = new Container(mockCtx, mockEnv, { secretsStoreBindings: explicitBindings });
    (testContainer as any).ctx = mockCtx;

    // Should use explicit bindings, not auto-detected ones
    expect(testContainer.secretsStoreBindings).toEqual(explicitBindings);
    expect(testContainer.secretsStoreBindings.length).toBe(1);
  });

  test('should handle validation errors for missing environment variables', () => {
    const secretsStoreBindings = [
      {
        binding: 'API_SECRETS',
        storeId: 'my-app-secrets',
        secretName: 'api-secrets'
      }
    ];

    // Mock environment with missing variables
    const originalEnv = process.env;
    process.env = {
      ...originalEnv
      // No SECRETS_* variables set
    };

    try {
      // @ts-ignore - ignore TypeScript errors for testing
      const testContainer = new Container(mockCtx, {}, { secretsStoreBindings });
      (testContainer as any).ctx = mockCtx;

      const validation = testContainer.validateSecretsStoreBindingEnvironment();

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain("Secrets Store binding 'API_SECRETS' not found in environment variables");
    } finally {
      process.env = originalEnv;
    }
  });

  test('should handle validation errors for partial environment variables', () => {
    const secretsStoreBindings = [
      {
        binding: 'API_SECRETS',
        storeId: 'my-app-secrets',
        secretName: 'api-secrets'
      }
    ];

    // Mock environment with only partial variables
    const originalEnv = process.env;
    process.env = {
      ...originalEnv,
      'SECRETS_API_SECRETS_BINDING': 'API_SECRETS'
      // Missing STORE_ID and SECRET_NAME
    };

    try {
      // @ts-ignore - ignore TypeScript errors for testing
      const testContainer = new Container(mockCtx, {}, { secretsStoreBindings });
      (testContainer as any).ctx = mockCtx;

      const validation = testContainer.validateSecretsStoreBindingEnvironment();

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('SECRETS_API_SECRETS_STORE_ID environment variable missing');
      expect(validation.errors).toContain('SECRETS_API_SECRETS_SECRET_NAME environment variable missing');
    } finally {
      process.env = originalEnv;
    }
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
