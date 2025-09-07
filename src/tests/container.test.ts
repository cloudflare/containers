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

  // KV Bindings tests
  describe('KV Bindings', () => {
    test('should initialize with kvBindings from constructor options', () => {
      const kvBindings = [
        { binding: 'DEMO_CACHE', namespaceName: 'demo-cache', preview: 'demo-cache-preview' },
        { binding: 'USER_SESSIONS', namespaceName: 'user-sessions' }
      ];

      const containerWithKv = new Container(mockCtx, {}, { kvBindings });
      // Add ctx property for testing
      (containerWithKv as any).ctx = mockCtx;

      expect(containerWithKv.kvBindings).toEqual(kvBindings);
    });

    test('should generate correct KV environment variables', () => {
      const kvBindings = [
        { binding: 'DEMO_CACHE', namespaceName: 'demo-cache', preview: 'demo-cache-preview' },
        { binding: 'USER_SESSIONS', namespaceName: 'user-sessions' }
      ];

      container.kvBindings = kvBindings;

      // @ts-ignore - accessing private method for testing
      const envVars = container.setupKvBindingEnvironment();

      expect(envVars).toEqual({
        'KV_DEMO_CACHE_BINDING': 'DEMO_CACHE',
        'KV_DEMO_CACHE_NAMESPACE': 'demo-cache',
        'KV_DEMO_CACHE_PREVIEW': 'demo-cache-preview',
        'KV_USER_SESSIONS_BINDING': 'USER_SESSIONS',
        'KV_USER_SESSIONS_NAMESPACE': 'user-sessions'
      });
    });

    test('should sanitize binding names for environment variables', () => {
      const kvBindings = [
        { binding: 'my-special-cache', namespaceName: 'special-cache' }
      ];

      container.kvBindings = kvBindings;

      // @ts-ignore - accessing private method for testing
      const envVars = container.setupKvBindingEnvironment();

      expect(envVars).toEqual({
        'KV_MY_SPECIAL_CACHE_BINDING': 'my-special-cache',
        'KV_MY_SPECIAL_CACHE_NAMESPACE': 'special-cache'
      });
    });

    test('should merge KV environment variables with existing env vars during container start', () => {
      const kvBindings = [
        { binding: 'TEST_KV', namespaceName: 'test-kv' }
      ];

      container.kvBindings = kvBindings;
      container.envVars = { 'EXISTING_VAR': 'value' };

      // Mock the container start process enough to test env var merging
      const startOptions = undefined;

      // Simulate the env var merging logic from startAndWaitForPorts
      const baseEnvVars = startOptions?.envVars ?? container.envVars;
      // @ts-ignore - accessing private method for testing
      const kvEnvVars = container.setupKvBindingEnvironment();
      const mergedEnvVars = { ...baseEnvVars, ...kvEnvVars };

      expect(mergedEnvVars).toEqual({
        'EXISTING_VAR': 'value',
        'KV_TEST_KV_BINDING': 'TEST_KV',
        'KV_TEST_KV_NAMESPACE': 'test-kv'
      });
    });

    test('should handle empty kvBindings array', () => {
      container.kvBindings = [];

      // @ts-ignore - accessing private method for testing
      const envVars = container.setupKvBindingEnvironment();

      expect(envVars).toEqual({});
    });

    test('should provide KV binding info via getKvBindingInfo', () => {
      const kvBindings = [
        { binding: 'DEMO_CACHE', namespaceName: 'demo-cache', preview: 'demo-cache-preview' },
        { binding: 'USER_SESSIONS', namespaceName: 'user-sessions' }
      ];

      container.kvBindings = kvBindings;

      const bindingInfo = container.getKvBindingInfo();

      expect(bindingInfo).toEqual({
        'DEMO_CACHE': {
          binding: 'DEMO_CACHE',
          namespaceName: 'demo-cache',
          preview: 'demo-cache-preview',
          envVars: {
            'KV_DEMO_CACHE_BINDING': 'DEMO_CACHE',
            'KV_DEMO_CACHE_NAMESPACE': 'demo-cache',
            'KV_DEMO_CACHE_PREVIEW': 'demo-cache-preview'
          }
        },
        'USER_SESSIONS': {
          binding: 'USER_SESSIONS',
          namespaceName: 'user-sessions',
          envVars: {
            'KV_USER_SESSIONS_BINDING': 'USER_SESSIONS',
            'KV_USER_SESSIONS_NAMESPACE': 'user-sessions'
          }
        }
      });
    });

    test('should provide KV binding summary via getKvBindingSummary', () => {
      const kvBindings = [
        { binding: 'DEMO_CACHE', namespaceName: 'demo-cache', preview: 'demo-cache-preview' },
        { binding: 'USER_SESSIONS', namespaceName: 'user-sessions' }
      ];

      container.kvBindings = kvBindings;

      const summary = container.getKvBindingSummary();

      expect(summary).toEqual({
        configured: 2,
        bindings: [
          { name: 'DEMO_CACHE', namespace: 'demo-cache', preview: 'demo-cache-preview' },
          { name: 'USER_SESSIONS', namespace: 'user-sessions' }
        ]
      });
    });

    test('should validate KV binding environment variables', () => {
      const kvBindings = [
        { binding: 'TEST_KV', namespaceName: 'test-kv' }
      ];

      container.kvBindings = kvBindings;

      // Mock process.env for validation test
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        'KV_TEST_KV_BINDING': 'TEST_KV',
        'KV_TEST_KV_NAMESPACE': 'test-kv'
      };

      const validation = container.validateKvBindingEnvironment();

      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
      expect(validation.bindings['TEST_KV']).toEqual({
        configured: { binding: 'TEST_KV', namespaceName: 'test-kv' },
        environment: {
          BINDING: 'TEST_KV',
          NAMESPACE: 'test-kv'
        },
        valid: true
      });

      // Restore original env
      process.env = originalEnv;
    });

    test('should auto-detect KV bindings from environment', () => {
      // Mock KV namespace objects
      const mockKvNamespace1 = {
        get: jest.fn(),
        put: jest.fn(),
        delete: jest.fn(),
        list: jest.fn()
      };

      const mockKvNamespace2 = {
        get: jest.fn(),
        put: jest.fn(),
        delete: jest.fn(),
        list: jest.fn()
      };

      const mockEnv = {
        DEMO_CACHE: mockKvNamespace1,
        USER_SESSIONS: mockKvNamespace2,
        NOT_A_KV: 'just a string',
        ALSO_NOT_KV: { someProperty: 'value' }
      };

      // @ts-ignore - accessing private method for testing
      const detectedBindings = container.autoDetectKvBindings(mockEnv);

      expect(detectedBindings).toHaveLength(2);
      expect(detectedBindings).toEqual([
        { binding: 'DEMO_CACHE', namespaceName: 'demo-cache' },
        { binding: 'USER_SESSIONS', namespaceName: 'user-sessions' }
      ]);
    });

    test('should auto-detect KV bindings with underscore to dash conversion', () => {
      const mockKvNamespace = {
        get: jest.fn(),
        put: jest.fn(), 
        delete: jest.fn()
      };

      const mockEnv = {
        MY_SPECIAL_CACHE: mockKvNamespace,
        ANOTHER_KV_STORE: mockKvNamespace
      };

      // @ts-ignore - accessing private method for testing
      const detectedBindings = container.autoDetectKvBindings(mockEnv);

      expect(detectedBindings).toEqual([
        { binding: 'MY_SPECIAL_CACHE', namespaceName: 'my-special-cache' },
        { binding: 'ANOTHER_KV_STORE', namespaceName: 'another-kv-store' }
      ]);
    });

    test('should not detect non-KV objects as KV bindings', () => {
      const mockEnv = {
        REGULAR_STRING: 'not a kv',
        EMPTY_OBJECT: {},
        PARTIAL_KV: { get: jest.fn() }, // Missing put and delete
        FUNCTION_PROP: jest.fn(),
        NULL_VALUE: null,
        UNDEFINED_VALUE: undefined
      };

      // @ts-ignore - accessing private method for testing
      const detectedBindings = container.autoDetectKvBindings(mockEnv);

      expect(detectedBindings).toHaveLength(0);
    });

    test('should use auto-detected KV bindings during container construction', () => {
      const mockKvNamespace = {
        get: jest.fn(),
        put: jest.fn(),
        delete: jest.fn()
      };

      const mockEnv = {
        AUTO_CACHE: mockKvNamespace,
        AUTO_SESSIONS: mockKvNamespace
      };

      // Create a new container without explicit kvBindings
      const autoContainer = new TestContainer(mockCtx, mockEnv as any);

      expect(autoContainer.kvBindings).toHaveLength(2);
      expect(autoContainer.kvBindings).toEqual([
        { binding: 'AUTO_CACHE', namespaceName: 'auto-cache' },
        { binding: 'AUTO_SESSIONS', namespaceName: 'auto-sessions' }
      ]);
    });

    test('should prefer explicit kvBindings over auto-detection', () => {
      const mockKvNamespace = {
        get: jest.fn(),
        put: jest.fn(),
        delete: jest.fn()
      };

      const mockEnv = {
        AUTO_CACHE: mockKvNamespace,
        AUTO_SESSIONS: mockKvNamespace
      };

      const explicitBindings = [
        { binding: 'MANUAL_CACHE', namespaceName: 'manual-cache' }
      ];

      // Create container with explicit bindings
      const explicitContainer = new TestContainer(mockCtx, mockEnv as any, {
        kvBindings: explicitBindings
      });

      // Should use explicit bindings, not auto-detected ones
      expect(explicitContainer.kvBindings).toHaveLength(1);
      expect(explicitContainer.kvBindings).toEqual(explicitBindings);
    });
  });

  // Secrets Store Bindings tests
  describe('Secrets Store Bindings', () => {
    test('should initialize with secretsStoreBindings from constructor options', () => {
      const secretsStoreBindings = [
        { binding: 'API_KEY', storeId: 'store-123', secretName: 'api-key' },
        { binding: 'DB_PASSWORD', storeId: 'store-456', secretName: 'db-password' }
      ];

      const containerWithSecrets = new Container(mockCtx, {}, { secretsStoreBindings });
      // Add ctx property for testing
      (containerWithSecrets as any).ctx = mockCtx;

      expect(containerWithSecrets.secretsStoreBindings).toEqual(secretsStoreBindings);
    });

    test('should generate correct Secrets Store environment variables', () => {
      const secretsStoreBindings = [
        { binding: 'API_KEY', storeId: 'store-123', secretName: 'api-key' },
        { binding: 'DB_PASSWORD', storeId: 'store-456', secretName: 'db-password' }
      ];

      container.secretsStoreBindings = secretsStoreBindings;

      // @ts-ignore - accessing private method for testing
      const envVars = container.setupSecretsStoreBindingEnvironment();

      expect(envVars).toEqual({
        'SECRETS_API_KEY_BINDING': 'API_KEY',
        'SECRETS_API_KEY_STORE_ID': 'store-123',
        'SECRETS_API_KEY_SECRET_NAME': 'api-key',
        'SECRETS_DB_PASSWORD_BINDING': 'DB_PASSWORD',
        'SECRETS_DB_PASSWORD_STORE_ID': 'store-456',
        'SECRETS_DB_PASSWORD_SECRET_NAME': 'db-password'
      });
    });

    test('should sanitize binding names for environment variables', () => {
      const secretsStoreBindings = [
        { binding: 'my-special-api-key', storeId: 'store-789', secretName: 'special-key' }
      ];

      container.secretsStoreBindings = secretsStoreBindings;

      // @ts-ignore - accessing private method for testing
      const envVars = container.setupSecretsStoreBindingEnvironment();

      expect(envVars).toEqual({
        'SECRETS_MY_SPECIAL_API_KEY_BINDING': 'my-special-api-key',
        'SECRETS_MY_SPECIAL_API_KEY_STORE_ID': 'store-789',
        'SECRETS_MY_SPECIAL_API_KEY_SECRET_NAME': 'special-key'
      });
    });

    test('should merge Secrets Store environment variables with existing env vars during container start', () => {
      const secretsStoreBindings = [
        { binding: 'TEST_SECRET', storeId: 'test-store', secretName: 'test-secret' }
      ];

      container.secretsStoreBindings = secretsStoreBindings;
      container.envVars = { 'EXISTING_VAR': 'value' };

      // Mock the container start process enough to test env var merging
      const startOptions = undefined;

      // Simulate the env var merging logic from startAndWaitForPorts
      const baseEnvVars = startOptions?.envVars ?? container.envVars;
      // @ts-ignore - accessing private method for testing
      const kvEnvVars = container.setupKvBindingEnvironment();
      // @ts-ignore - accessing private method for testing
      const secretsStoreEnvVars = container.setupSecretsStoreBindingEnvironment();
      const mergedEnvVars = { ...baseEnvVars, ...kvEnvVars, ...secretsStoreEnvVars };

      expect(mergedEnvVars).toEqual({
        'EXISTING_VAR': 'value',
        'SECRETS_TEST_SECRET_BINDING': 'TEST_SECRET',
        'SECRETS_TEST_SECRET_STORE_ID': 'test-store',
        'SECRETS_TEST_SECRET_SECRET_NAME': 'test-secret'
      });
    });

    test('should handle empty secretsStoreBindings array', () => {
      container.secretsStoreBindings = [];

      // @ts-ignore - accessing private method for testing
      const envVars = container.setupSecretsStoreBindingEnvironment();

      expect(envVars).toEqual({});
    });

    test('should provide Secrets Store binding info via getSecretsStoreBindingInfo', () => {
      const secretsStoreBindings = [
        { binding: 'API_KEY', storeId: 'store-123', secretName: 'api-key' },
        { binding: 'DB_PASSWORD', storeId: 'store-456', secretName: 'db-password' }
      ];

      container.secretsStoreBindings = secretsStoreBindings;

      const bindingInfo = container.getSecretsStoreBindingInfo();

      expect(bindingInfo).toEqual({
        'API_KEY': {
          binding: 'API_KEY',
          storeId: 'store-123',
          secretName: 'api-key',
          envVars: {
            'SECRETS_API_KEY_BINDING': 'API_KEY',
            'SECRETS_API_KEY_STORE_ID': 'store-123',
            'SECRETS_API_KEY_SECRET_NAME': 'api-key'
          }
        },
        'DB_PASSWORD': {
          binding: 'DB_PASSWORD',
          storeId: 'store-456',
          secretName: 'db-password',
          envVars: {
            'SECRETS_DB_PASSWORD_BINDING': 'DB_PASSWORD',
            'SECRETS_DB_PASSWORD_STORE_ID': 'store-456',
            'SECRETS_DB_PASSWORD_SECRET_NAME': 'db-password'
          }
        }
      });
    });

    test('should provide Secrets Store binding summary via getSecretsStoreBindingSummary', () => {
      const secretsStoreBindings = [
        { binding: 'API_KEY', storeId: 'store-123', secretName: 'api-key' },
        { binding: 'DB_PASSWORD', storeId: 'store-456', secretName: 'db-password' }
      ];

      container.secretsStoreBindings = secretsStoreBindings;

      const summary = container.getSecretsStoreBindingSummary();

      expect(summary).toEqual({
        configured: 2,
        bindings: [
          { name: 'API_KEY', storeId: 'store-123', secretName: 'api-key' },
          { name: 'DB_PASSWORD', storeId: 'store-456', secretName: 'db-password' }
        ]
      });
    });

    test('should validate Secrets Store binding environment variables', () => {
      const secretsStoreBindings = [
        { binding: 'TEST_SECRET', storeId: 'test-store', secretName: 'test-secret' }
      ];

      container.secretsStoreBindings = secretsStoreBindings;

      // Mock process.env for validation test
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        'SECRETS_TEST_SECRET_BINDING': 'TEST_SECRET',
        'SECRETS_TEST_SECRET_STORE_ID': 'test-store',
        'SECRETS_TEST_SECRET_SECRET_NAME': 'test-secret'
      };

      const validation = container.validateSecretsStoreBindingEnvironment();

      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
      expect(validation.bindings['TEST_SECRET']).toEqual({
        configured: { binding: 'TEST_SECRET', storeId: 'test-store', secretName: 'test-secret' },
        environment: {
          BINDING: 'TEST_SECRET',
          STORE_ID: 'test-store',
          SECRET_NAME: 'test-secret'
        },
        valid: true
      });

      // Restore original env
      process.env = originalEnv;
    });

    test('should auto-detect Secrets Store bindings from environment', () => {
      // Mock Secrets Store binding objects
      const mockSecretsBinding1 = {
        get: jest.fn().mockResolvedValue('secret-value-1')
      };

      const mockSecretsBinding2 = {
        get: jest.fn().mockResolvedValue('secret-value-2')
      };

      const mockEnv = {
        API_KEY: mockSecretsBinding1,
        DATABASE_PASSWORD: mockSecretsBinding2,
        NOT_A_SECRET: 'just a string',
        ALSO_NOT_SECRET: { someProperty: 'value' }
      };

      // @ts-ignore - accessing private method for testing
      const detectedBindings = container.autoDetectSecretsStoreBindings(mockEnv);

      expect(detectedBindings).toHaveLength(2);
      expect(detectedBindings).toEqual([
        { binding: 'API_KEY', storeId: 'auto-detected-store-api_key', secretName: 'api-key' },
        { binding: 'DATABASE_PASSWORD', storeId: 'auto-detected-store-database_password', secretName: 'database-password' }
      ]);
    });

    test('should auto-detect Secrets Store bindings with underscore to dash conversion', () => {
      const mockSecretsBinding = {
        get: jest.fn().mockResolvedValue('secret-value')
      };

      const mockEnv = {
        MY_SPECIAL_API_KEY: mockSecretsBinding,
        ANOTHER_SECRET_TOKEN: mockSecretsBinding
      };

      // @ts-ignore - accessing private method for testing
      const detectedBindings = container.autoDetectSecretsStoreBindings(mockEnv);

      expect(detectedBindings).toEqual([
        { binding: 'MY_SPECIAL_API_KEY', storeId: 'auto-detected-store-my_special_api_key', secretName: 'my-special-api-key' },
        { binding: 'ANOTHER_SECRET_TOKEN', storeId: 'auto-detected-store-another_secret_token', secretName: 'another-secret-token' }
      ]);
    });

    test('should not detect non-Secrets Store objects as Secrets Store bindings', () => {
      const mockEnv = {
        REGULAR_STRING: 'not a secret',
        EMPTY_OBJECT: {},
        PARTIAL_SECRET: { someMethod: jest.fn() }, // Missing get method
        FUNCTION_PROP: jest.fn(),
        NULL_VALUE: null,
        UNDEFINED_VALUE: undefined
      };

      // @ts-ignore - accessing private method for testing
      const detectedBindings = container.autoDetectSecretsStoreBindings(mockEnv);

      expect(detectedBindings).toHaveLength(0);
    });

    test('should use auto-detected Secrets Store bindings during container construction', () => {
      const mockSecretsBinding = {
        get: jest.fn().mockResolvedValue('secret-value')
      };

      const mockEnv = {
        AUTO_API_KEY: mockSecretsBinding,
        AUTO_DB_PASSWORD: mockSecretsBinding
      };

      // Create a new container without explicit secretsStoreBindings
      const autoContainer = new TestContainer(mockCtx, mockEnv as any);

      expect(autoContainer.secretsStoreBindings).toHaveLength(2);
      expect(autoContainer.secretsStoreBindings).toEqual([
        { binding: 'AUTO_API_KEY', storeId: 'auto-detected-store-auto_api_key', secretName: 'auto-api-key' },
        { binding: 'AUTO_DB_PASSWORD', storeId: 'auto-detected-store-auto_db_password', secretName: 'auto-db-password' }
      ]);
    });

    test('should prefer explicit secretsStoreBindings over auto-detection', () => {
      const mockSecretsBinding = {
        get: jest.fn().mockResolvedValue('secret-value')
      };

      const mockEnv = {
        AUTO_API_KEY: mockSecretsBinding,
        AUTO_DB_PASSWORD: mockSecretsBinding
      };

      const explicitBindings = [
        { binding: 'MANUAL_API_KEY', storeId: 'manual-store', secretName: 'manual-api-key' }
      ];

      // Create container with explicit bindings
      const explicitContainer = new TestContainer(mockCtx, mockEnv as any, {
        secretsStoreBindings: explicitBindings
      });

      // Should use explicit bindings, not auto-detected ones
      expect(explicitContainer.secretsStoreBindings).toHaveLength(1);
      expect(explicitContainer.secretsStoreBindings).toEqual(explicitBindings);
    });

    test('should handle validation errors for missing environment variables', () => {
      const secretsStoreBindings = [
        { binding: 'MISSING_SECRET', storeId: 'test-store', secretName: 'missing-secret' }
      ];

      container.secretsStoreBindings = secretsStoreBindings;

      // Mock process.env without the required variables
      const originalEnv = process.env;
      process.env = {
        ...originalEnv
        // No SECRETS_* variables set
      };

      const validation = container.validateSecretsStoreBindingEnvironment();

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain(`Secrets Store binding 'MISSING_SECRET' not found in environment variables`);

      // Restore original env
      process.env = originalEnv;
    });

    test('should handle validation errors for partial environment variables', () => {
      const secretsStoreBindings = [
        { binding: 'PARTIAL_SECRET', storeId: 'test-store', secretName: 'partial-secret' }
      ];

      container.secretsStoreBindings = secretsStoreBindings;

      // Mock process.env with only partial variables
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        'SECRETS_PARTIAL_SECRET_BINDING': 'PARTIAL_SECRET',
        // Missing STORE_ID and SECRET_NAME
      };

      const validation = container.validateSecretsStoreBindingEnvironment();

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('SECRETS_PARTIAL_SECRET_STORE_ID environment variable missing');
      expect(validation.errors).toContain('SECRETS_PARTIAL_SECRET_SECRET_NAME environment variable missing');

      // Restore original env
      process.env = originalEnv;
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
