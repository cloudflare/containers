import type {
  ContainerOptions,
  ContainerStartOptions,
  ContainerStartConfigOptions,
  Schedule,
  StopParams,
  ScheduleSQL,
  State,
  WaitOptions,
} from '../types';
import { generateId, parseTimeExpression } from './helpers';
import { DurableObject } from 'cloudflare:workers';

// ====================
// ====================
//      CONSTANTS
// ====================
// ====================

const NO_CONTAINER_INSTANCE_ERROR =
  'there is no container instance that can be provided to this durable object';
const RUNTIME_SIGNALLED_ERROR = 'runtime signalled the container to exit:';
const UNEXPECTED_EDIT_ERROR = 'container exited with unexpected exit code:';
const NOT_LISTENING_ERROR = 'the container is not listening';
const CONTAINER_STATE_KEY = '__CF_CONTAINER_STATE';

// maxRetries before scheduling next alarm is purposely set to 3,
// as according to DO docs at https://developers.cloudflare.com/durable-objects/api/alarms/
// the maximum amount for alarm retries is 6.
const MAX_ALAEM_RETRIES = 3;

const DEFAULT_SLEEP_AFTER = '10m'; // Default sleep after inactivity time
const DEFAULT_INSTANCE_POLL_INTERVAL_MS = 500; // Default interval for polling container state
const DEFAULT_INSTANCE_RETRY_COUNT = Infinity;

const START_TIMEOUT_MS = 25_000;  // Amount of time to wait on a container to start before erroring

// =====================
// =====================
//   HELPER FUNCTIONS
// =====================
// =====================

// ==== Error helpers ====

function isErrorOfType(error: unknown, matchingString: string): boolean {
  if (error instanceof String) {
    error.includes(matchingString);
  }

  if (error instanceof Error) {
    error.message.includes(matchingString);
  }

  return false;
}

const isNoInstanceError = (error: unknown): boolean =>
  isErrorOfType(error, NO_CONTAINER_INSTANCE_ERROR);
const isRuntimeSignalledError = (error: unknown): boolean =>
  isErrorOfType(error, RUNTIME_SIGNALLED_ERROR);
const isNotListeningError = (error: unknown): boolean => isErrorOfType(error, NOT_LISTENING_ERROR);
const isContainerExitNonZeroError = (error: unknown): boolean =>
  isErrorOfType(error, UNEXPECTED_EDIT_ERROR);

function getExitCodeFromError(error: unknown): number | null {
  if (!(error instanceof Error)) {
    return null;
  }

  if (isRuntimeSignalledError(error)) {
    return +error.message.slice(
      error.message.indexOf(RUNTIME_SIGNALLED_ERROR) + RUNTIME_SIGNALLED_ERROR.length + 1
    );
  }

  if (isContainerExitNonZeroError(error)) {
    return +error.message.slice(
      error.message.indexOf(UNEXPECTED_EDIT_ERROR) + UNEXPECTED_EDIT_ERROR.length + 1
    );
  }

  return null;
}

// ==== Stream helpers ====

function attachOnClosedHook(stream: ReadableStream, onClosed: () => void): ReadableStream {
  let destructor: (() => void) | null = () => {
    onClosed();
    destructor = null;
  };

  // we pass the readableStream through a transform stream to detect if the
  // body has been closed.
  const transformStream = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
    flush() {
      if (destructor) {
        destructor();
      }
    },
    cancel() {
      if (destructor) {
        destructor();
      }
    },
  });
  return stream.pipeThrough(transformStream);
}

// ===============================
//     CONTAINER STATE WRAPPER
// ===============================

/**
 * ContainerState is a wrapper around a DO storage to store and get
 * the container state.
 * It's useful to track which kind of events have been handled by the user,
 * a transition to a new state won't be successful unless the user's hook has been
 * triggered and waited for.
 * A user hook might be repeated multiple times if they throw errors.
 */
class ContainerState {
  status?: State;
  constructor(private storage: DurableObject['ctx']['storage']) {}

  async setRunning() {
    await this.setStatusAndupdate('running');
  }

  async setHealthy() {
    await this.setStatusAndupdate('healthy');
  }

  async setStopping() {
    await this.setStatusAndupdate('stopping');
  }

  async setStopped() {
    await this.setStatusAndupdate('stopped');
  }

  async setStoppedWithCode(exitCode: number) {
    this.status = { status: 'stopped_with_code', lastChange: Date.now(), exitCode };
    await this.update();
  }

  async getState(): Promise<State> {
    if (!this.status) {
      const state = await this.storage.get<State>(CONTAINER_STATE_KEY);
      if (!state) {
        this.status = {
          status: 'stopped',
          lastChange: Date.now(),
        };
        await this.update();
      } else {
        this.status = state;
      }
    }

    return this.status!;
  }

  private async setStatusAndupdate(status: State['status']) {
    this.status = { status: status, lastChange: Date.now() };
    await this.update();
  }

  private async update() {
    if (!this.status) throw new Error('status should be init');
    await this.storage.put<State>(CONTAINER_STATE_KEY, this.status);
  }
}

// ===============================
// ===============================
//     MAIN CONTAINER CLASS
// ===============================
// ===============================

export class Container<Env = unknown> extends DurableObject<Env> {
  // =========================
  //     Public Attributes
  // =========================

  // Default port for the container (undefined means no default port)
  defaultPort?: number;

  // Required ports that should be checked for availability during container startup
  // Override this in your subclass to specify ports that must be ready
  requiredPorts?: number[];

  // Timeout after which the container will sleep if no activity
  // The signal sent to the container by default is a SIGTERM.
  // The container won't get a SIGKILL if this threshold is triggered.
  sleepAfter: string | number = DEFAULT_SLEEP_AFTER;

  // Whether to require manual container start (if true, it won't start automatically)
  manualStart = false;

  // Container configuration properties
  // Set these properties directly in your container instance
  envVars: ContainerStartOptions['env'] = {};
  entrypoint: ContainerStartOptions['entrypoint'];
  enableInternet: ContainerStartOptions['enableInternet'] = true;

  // =========================
  //     PUBLIC INTERFACE
  // =========================

  constructor(ctx: DurableObject['ctx'], env: Env, options?: ContainerOptions) {
    super(ctx, env);

    this.state = new ContainerState(this.ctx.storage);

    this.ctx.blockConcurrencyWhile(async () => {
      this.renewActivityTimeout();

      // First thing, schedule the next alarms
      await this.scheduleNextAlarm();
    });

    if (ctx.container === undefined) {
      throw new Error(
        'Container is not enabled for this durable object class. Have you correctly setup your wrangler.toml?'
      );
    }

    this.container = ctx.container;

    // Apply options if provided
    if (options) {
      if (options.defaultPort !== undefined) this.defaultPort = options.defaultPort;
      if (options.sleepAfter !== undefined) this.sleepAfter = options.sleepAfter;
      if (options.explicitContainerStart !== undefined)
        this.manualStart = options.explicitContainerStart;
    }

    // Create schedules table if it doesn't exist
    this.sql`
      CREATE TABLE IF NOT EXISTS container_schedules (
        id TEXT PRIMARY KEY NOT NULL DEFAULT (randomblob(9)),
        callback TEXT NOT NULL,
        payload TEXT,
        type TEXT NOT NULL CHECK(type IN ('scheduled', 'delayed')),
        time INTEGER NOT NULL,
        delayInSeconds INTEGER,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `;

    // Start the container automatically if needed
    this.ctx.blockConcurrencyWhile(async () => {
      if (this.shouldAutoStart()) {
        const timeout = AbortSignal.timeout(START_TIMEOUT_MS);

        // Start container and wait for any required ports
        await this.startAndWaitForPorts([], {
          abort: timeout,
        });

        // Activity timeout is initialized in startAndWaitForPorts
      } else if (this.container.running && !this.monitor) {
        this.monitor = this.container.monitor();
        this.setupMonitor();
      }
    });
  }

  // ==========================
  //     CONTAINER STARTING
  // ==========================

  /**
   * Start the container if it's not running and set up monitoring
   *
   * This method handles the core container startup process without waiting for ports to be ready.
   * It will automatically retry if the container fails to start, up to maxTries attempts.
   *
   * It's useful when you need to:
   * - Start a container without blocking until a port is available
   * - Initialize a container that doesn't expose ports
   * - Perform custom port availability checks separately
   *
   * The method applies the container configuration from your instance properties by default, but allows
   * overriding these values for this specific startup:
   * - Environment variables (defaults to this.envVars)
   * - Custom entrypoint commands (defaults to this.entrypoint)
   * - Internet access settings (defaults to this.enableInternet)
   *
   * It also sets up monitoring to track container lifecycle events and automatically
   * calls the onStop handler when the container terminates.
   *
   * @example
   * // Basic usage in a custom Container implementation
   * async customInitialize() {
   *   // Start the container without waiting for a port
   *   await this.start();
   *
   *   // Perform additional initialization steps
   *   // that don't require port access
   * }
   *
   * @example
   * // Start with custom configuration
   * await this.start({
   *   envVars: { DEBUG: 'true', NODE_ENV: 'development' },
   *   entrypoint: ['npm', 'run', 'dev'],
   *   enableInternet: false
   * });
   *
   * @param options - Optional configuration to override instance defaults
   * @param waitOptions - Optional wait configuration with abort signal for cancellation
   * @returns A promise that resolves when the container start command has been issued
   * @throws Error if no container context is available or if all start attempts fail
   */
  public async start(
    options?: ContainerStartConfigOptions,
    waitOptions?: { signal?: AbortSignal }
  ): Promise<void> {
    await this.startContainerIfNotRunning(
      {
        abort: waitOptions?.signal,
        waitInterval: DEFAULT_INSTANCE_POLL_INTERVAL_MS,
        retries: DEFAULT_INSTANCE_RETRY_COUNT,
      },
      options
    );

    this.setupMonitor();
  }

  /**
   * Start the container and wait for ports to be available
   * Based on containers-starter-go implementation
   *
   * This method builds on start() by adding port availability verification:
   * 1. Calls start() to ensure the container is running
   * 2. If no ports are specified and requiredPorts is not set, it uses defaultPort (if set)
   * 3. If no ports can be determined, it calls onStart and renewActivityTimeout immediately
   * 4. For each specified port, it polls until the port is available or maxTries is reached
   * 5. When all ports are available, it triggers onStart and renewActivityTimeout
   *
   * The method prioritizes port sources in this order:
   * 1. Ports specified directly in the method call
   * 2. requiredPorts class property (if set)
   * 3. defaultPort (if neither of the above is specified)
   *
   * @param ports - The ports to wait for (if undefined, uses requiredPorts or defaultPort)
   * @param maxTries - Maximum number of attempts to connect to each port before failing
   * @throws Error if port checks fail after maxTries attempts
   */
  public async startAndWaitForPorts(
    ports?: number | number[],
    cancellationOptions?: { abort?: AbortSignal; retries?: number; waitInterval?: number }
  ): Promise<void> {
    const state = await this.state.getState();

    cancellationOptions ??= {};
    const options = {
      abort: cancellationOptions.abort,
      retries: cancellationOptions.retries ?? DEFAULT_INSTANCE_RETRY_COUNT,
      waitInterval: cancellationOptions.waitInterval ?? DEFAULT_INSTANCE_POLL_INTERVAL_MS,
    };

    if (state.status === 'healthy' && this.container.running) {
      if (this.container.running && !this.monitor) {
        await this.startContainerIfNotRunning(options);
        this.setupMonitor();
      }

      return;
    }

    // trigger all onStop that we didn't do yet
    await this.syncPendingStoppedEvents();
    const abortedSignal = new Promise(res => {
      options.abort?.addEventListener('abort', () => {
        res(true);
      });
    });

    await this.ctx.blockConcurrencyWhile(async () => {
      // Start the container if it's not running
      await this.startContainerIfNotRunning(options);

      // Determine which ports to check
      let portsToCheck: number[] = [];

      if (ports !== undefined) {
        // Use explicitly provided ports (single port or array)
        portsToCheck = Array.isArray(ports) ? ports : [ports];
      } else if (this.requiredPorts && this.requiredPorts.length > 0) {
        // Use requiredPorts class property if available
        portsToCheck = [...this.requiredPorts];
      } else if (this.defaultPort !== undefined) {
        // Fall back to defaultPort if available
        portsToCheck = [this.defaultPort];
      }

      // Check each port
      for (const port of portsToCheck) {
        const tcpPort = this.container.getTcpPort(port);
        let portReady = false;

        // Try to connect to the port multiple times
        for (let i = 0; i < options.retries && !portReady; i++) {
          try {
            await tcpPort.fetch('http://ping', { signal: options.abort });

            // Successfully connected to this port
            portReady = true;
            console.log(`Port ${port} is ready`);
          } catch (e) {
            // Check for specific error messages that indicate we should keep retrying
            const errorMessage = e instanceof Error ? e.message : String(e);

            console.warn(`Error checking ${port}: ${errorMessage}`);

            // If not running, it means the container crashed
            if (!this.container.running) {
              try {
                await this.onError(
                  new Error(
                    `Container crashed while checking for ports, did you setup the entrypoint correctly?`
                  )
                );
              } catch {}

              throw e;
            }

            // If we're on the last attempt and the port is still not ready, fail
            if (i === options.retries - 1) {
              try {
                this.onError(
                  `Failed to verify port ${port} is available after ${options.retries} attempts, last error: ${errorMessage}`
                );
              } catch {}
              throw e;
            }

            // Wait a bit before trying again
            await Promise.any([
              new Promise(resolve => setTimeout(resolve, options.waitInterval)),
              abortedSignal,
            ]);

            if (options.abort?.aborted) {
              throw new Error(
                'Received signal to abort request, we timed out waiting for the container to start'
              );
            }
          }
        }
      }
    });

    this.setupMonitor();

    await this.ctx.blockConcurrencyWhile(async () => {
      // All ports are ready
      await this.onStart();
      await this.state.setHealthy();
    });
  }

  // =======================
  //     LIFECYCLE HOOKS
  // =======================

  /**
   * Shuts down the container.
   * @param signal - The signal to send to the container (default: 15 for SIGTERM)
   */
  public async stop(signal = 15): Promise<void> {
    this.container.signal(signal);
  }

  /**
   * Destroys the container. It will trigger onError instead of onStop.
   */
  public async destroy(): Promise<void> {
    await this.container.destroy();
  }

  /**
   * Lifecycle method called when container starts successfully
   * Override this method in subclasses to handle container start events
   */
  public onStart(): void | Promise<void> {
    // Default implementation does nothing
  }

  /**
   * Lifecycle method called when container shuts down
   * Override this method in subclasses to handle Container stopped events
   * @param params - Object containing exitCode and reason for the stop
   */
  public onStop(_: StopParams): void | Promise<void> {
    // Default implementation does nothing
  }

  /**
   * Error handler for container errors
   * Override this method in subclasses to handle container errors
   * @param error - The error that occurred
   * @returns Can return any value or throw the error
   */
  public onError(error: unknown): any {
    console.error('Container error:', error);
    throw error;
  }


  /**
   * Renew the container's activity timeout
   *
   * Call this method whenever there is activity on the container
   */
  public renewActivityTimeout() {
    const timeoutInMs = parseTimeExpression(this.sleepAfter) * 1000;
    this.sleepAfterMs = Date.now() + timeoutInMs;
  }

  // ==================
  //     SCHEDULING
  // ==================

  /**
   * Schedule a task to be executed in the future
   * @template T Type of the payload data
   * @param when When to execute the task (Date object or number of seconds delay)
   * @param callback Name of the method to call
   * @param payload Data to pass to the callback
   * @returns Schedule object representing the scheduled task
   */
  public async schedule<T = string>(
    when: Date | number,
    callback: string,
    payload?: T
  ): Promise<Schedule<T>> {
    const id = generateId(9);

    // Ensure the callback is a string (method name)
    if (typeof callback !== 'string') {
      throw new Error('Callback must be a string (method name)');
    }

    // Ensure the method exists
    if (typeof this[callback as keyof this] !== 'function') {
      throw new Error(`this.${callback} is not a function`);
    }

    // Schedule based on the type of 'when' parameter
    if (when instanceof Date) {
      // Schedule for a specific time
      const timestamp = Math.floor(when.getTime() / 1000);

      this.sql`
        INSERT OR REPLACE INTO container_schedules (id, callback, payload, type, time)
        VALUES (${id}, ${callback}, ${JSON.stringify(payload)}, 'scheduled', ${timestamp})
      `;

      await this.scheduleNextAlarm();

      return {
        taskId: id,
        callback: callback,
        payload: payload as T,
        time: timestamp,
        type: 'scheduled',
      };
    }

    if (typeof when === 'number') {
      // Schedule for a delay in seconds
      const time = Math.floor(Date.now() / 1000 + when);

      this.sql`
        INSERT OR REPLACE INTO container_schedules (id, callback, payload, type, delayInSeconds, time)
        VALUES (${id}, ${callback}, ${JSON.stringify(payload)}, 'delayed', ${when}, ${time})
      `;

      await this.scheduleNextAlarm();

      return {
        taskId: id,
        callback: callback,
        payload: payload as T,
        delayInSeconds: when,
        time,
        type: 'delayed',
      };
    }

    throw new Error("Invalid schedule type. 'when' must be a Date or number of seconds");
  }

  // ============
  //     HTTP
  // ============

  /**
   * Send a request to the container (HTTP or WebSocket) using standard fetch API signature
   * Based on containers-starter-go implementation
   *
   * This method handles both HTTP and WebSocket requests to the container.
   * For WebSocket requests, it sets up bidirectional message forwarding with proper
   * activity timeout renewal.
   *
   * Method supports multiple signatures to match standard fetch API:
   * - containerFetch(request: Request, port?: number)
   * - containerFetch(url: string | URL, init?: RequestInit, port?: number)
   *
   * @param requestOrUrl The request object or URL string/object to send to the container
   * @param portOrInit Port number or fetch RequestInit options
   * @param portParam Optional port number when using URL+init signature
   * @returns A Response from the container, or WebSocket connection
   */
  public async containerFetch(
    requestOrUrl: Request | string | URL,
    portOrInit?: number | RequestInit,
    portParam?: number
  ): Promise<Response> {
    // Parse the arguments based on their types to handle different method signatures
    let request: Request;
    let port: number | undefined;

    // Determine if we're using the new signature or the old one
    if (requestOrUrl instanceof Request) {
      // Request-based: containerFetch(request, port?)
      request = requestOrUrl;
      port = typeof portOrInit === 'number' ? portOrInit : undefined;
    } else {
      // URL-based: containerFetch(url, init?, port?)
      const url = typeof requestOrUrl === 'string' ? requestOrUrl : requestOrUrl.toString();
      const init = typeof portOrInit === 'number' ? {} : portOrInit || {};
      port =
        typeof portOrInit === 'number'
          ? portOrInit
          : typeof portParam === 'number'
            ? portParam
            : undefined;

      // Create a Request object
      request = new Request(url, init);
    }

    // Require a port to be specified, either as a parameter or as a defaultPort property
    if (port === undefined && this.defaultPort === undefined) {
      throw new Error(
        'No port specified for container fetch. Set defaultPort or specify a port parameter.'
      );
    }

    // Use specified port or defaultPort
    const targetPort = port ?? this.defaultPort;

    const state = await this.state.getState();
    if (!this.container.running || state.status !== 'healthy') {
      try {
        await this.startAndWaitForPorts(targetPort, { abort: request.signal });
      } catch (e) {
        return new Response(
          `Failed to start container: ${e instanceof Error ? e.message : String(e)}`,
          { status: 500 }
        );
      }
    }

    const tcpPort = this.container.getTcpPort(targetPort!);

    // Create URL for the container request
    const containerUrl = request.url.replace('https:', 'http:');

    try {
      // Renew the activity timeout whenever a request is proxied
      this.renewActivityTimeout();

      if (request.body != null) {
        this.openStreamCount++;
        const destructor = () => {
          this.openStreamCount--;
          this.renewActivityTimeout();
        };

        const readable = attachOnClosedHook(request.body, destructor);
        request = new Request(request, { body: readable });
      }

      const res = await tcpPort.fetch(containerUrl, request);
      if (res.webSocket) {
        this.openStreamCount++;
        res.webSocket.addEventListener('close', async () => {
          this.openStreamCount--;
          this.renewActivityTimeout();
        });
      } else if (res.body != null) {
        this.openStreamCount++;
        const destructor = () => {
          this.openStreamCount--;
          this.renewActivityTimeout();
        };

        const readable = attachOnClosedHook(res.body, destructor);
        return new Response(readable, res);
      }

      return res;
    } catch (e) {
      console.error(`Error proxying request to container ${this.ctx.id}:`, e);
      return new Response(
        `Error proxying request to container: ${e instanceof Error ? e.message : String(e)}`,
        { status: 500 }
      );
    }
  }

  /**
   * Handle fetch requests to the Container
   * Default implementation forwards all HTTP and WebSocket requests to the container
   * Override this in your subclass to specify a port or implement custom request handling
   *
   * @param request The request to handle
   */
  override async fetch(request: Request): Promise<Response> {
    // Check if default port is set
    if (this.defaultPort === undefined) {
      return new Response(
        'No default port configured for this container. Override the fetch method or set defaultPort in your Container subclass.',
        { status: 500 }
      );
    }

    // Forward all requests (HTTP and WebSocket) to the container
    return await this.containerFetch(request, this.defaultPort);
  }

  // ===============================
  // ===============================
  //     PRIVATE METHODS & ATTRS
  // ===============================
  // ===============================

  // ==========================
  //     PRIVATE ATTRIBUTES
  // ==========================

  private container: NonNullable<DurableObject['ctx']['container']>;
  private state: ContainerState;
  private monitor: Promise<unknown> | undefined;

  private monitorSetup = false;
  // openStreamCount keeps track of the number of open streams to the container
  private openStreamCount = 0;

  private sleepAfterMs = 0;

  private alarmSleepPromise: Promise<unknown> | undefined;
  private alarmSleepResolve = (_: unknown) => {};

  // ==========================
  //     GENERAL HELPERS
  // ==========================

  /**
   * Try-catch wrapper for async operations
   */
  private async tryCatch<T>(fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      this.onError(e);
      throw e;
    }
  }

  private shouldAutoStart(): boolean {
    return !this.manualStart;
  }

  /**
   * Execute SQL queries against the Container's database
   */
  private sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ) {
    let query = '';
    try {
      // Construct the SQL query with placeholders
      query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? '?' : ''), '');

      // Execute the SQL query with the provided values
      return [...this.ctx.storage.sql.exec(query, ...values)] as T[];
    } catch (e) {
      console.error(`Failed to execute SQL query: ${query}`, e);
      throw this.onError(e);
    }
  }

  // ===========================================
  //     CONTAINER INTERACTION & MONITORING
  // ===========================================

  private async startContainerIfNotRunning(
    waitOptions: WaitOptions,
    options?: ContainerStartConfigOptions
  ): Promise<void> {
    // Start the container if it's not running
    if (this.container.running) {
      if (!this.monitor) {
        this.monitor = this.container.monitor();
      }

      return;
    }

    const abortedSignal = new Promise(res => {
      waitOptions.abort?.addEventListener('abort', () => {
        res(true);
      });
    });

    await this.state.setRunning();
    for (let tries = 0; tries < waitOptions.retries; tries++) {
      // Use provided options or fall back to instance properties
      const envVars = options?.envVars ?? this.envVars;
      const entrypoint = options?.entrypoint ?? this.entrypoint;
      const enableInternet = options?.enableInternet ?? this.enableInternet;

      // Only include properties that are defined
      const startConfig: ContainerStartOptions = {
        enableInternet,
      };

      if (envVars && Object.keys(envVars).length > 0) startConfig.env = envVars;
      if (entrypoint) startConfig.entrypoint = entrypoint;

      this.renewActivityTimeout();
      const handleError = async () => {
        const err = await this.monitor?.catch(err => err as Error);

        if (typeof err === 'number') {
          const toThrow = new Error(
            `Error starting container, early exit code 0 before we could check for healthiness, did it crash early?`
          );

          try {
            await this.onError(toThrow);
          } catch {}
          throw toThrow;
        } else if (!isNoInstanceError(err)) {
          try {
            await this.onError(err);
          } catch {}

          throw err;
        }
      };

      if (!this.container.running) {
        if (tries > 0) {
          await handleError();
        }

        this.container.start(startConfig);
        this.monitor = this.container.monitor();
      }

      this.renewActivityTimeout();
      await this.scheduleNextAlarm();
      const port = this.container.getTcpPort(33);
      try {
        await port.fetch('http://containerstarthealthcheck', { signal: waitOptions.abort });
        return;
      } catch (error) {
        if (isNotListeningError(error) && this.container.running) {
          return;
        }

        if (!this.container.running && isNotListeningError(error)) {
          try {
            await this.onError(new Error(`container crashed when checking if it was ready`));
          } catch {}

          throw error;
        }

        console.warn(
          'Error checking if container is ready:',
          error instanceof Error ? error.message : String(error)
        );

        await Promise.any([
          new Promise(res => setTimeout(res, waitOptions.waitInterval)),
          abortedSignal,
        ]);

        if (waitOptions.abort?.aborted) {
          throw new Error(
            'Aborted waiting for container to start as we received a cancellation signal'
          );
        }

        continue;
      }
    }
  }

  private setupMonitor() {
    if (this.monitorSetup) {
      return;
    }

    this.monitorSetup = true;
    this.monitor
      ?.then(async () => {
        const state = await this.state.getState();
        await this.ctx.blockConcurrencyWhile(async () => {
          const newState = await this.state.getState();
          // already informed
          if (newState.status !== state.status) {
            return;
          }

          await this.state.setStoppedWithCode(0);
          await this.onStop({ exitCode: 0, reason: 'exit' });
          await this.state.setStopped();
        });
      })
      .catch(async (error: unknown) => {
        if (isNoInstanceError(error)) {
          // we will inform later
          return;
        }

        const exitCode = getExitCodeFromError(error);
        if (exitCode !== null) {
          const state = await this.state.getState();
          this.ctx.blockConcurrencyWhile(async () => {
            const newState = await this.state.getState();
            // already informed
            if (newState.status !== state.status) {
              return;
            }

            await this.state.setStoppedWithCode(exitCode);
            await this.onStop({
              exitCode,
              reason: isRuntimeSignalledError(error) ? 'runtime_signal' : 'exit',
            });

            await this.state.setStopped();
          });

          return;
        }

        try {
          // TODO: Be able to retrigger onError
          await this.onError(error);
        } catch {}
      })
      .finally(() => {
        this.monitorSetup = false;
        this.alarmSleepResolve('monitor finally');
      });
  }

  // ============================
  //     ALARMS AND SCHEDULES
  // ============================

  /**
   * Method called when an alarm fires
   * Executes any scheduled tasks that are due
   */
  override async alarm(alarmProps: { isRetry: boolean; retryCount: number }): Promise<void> {
    if (alarmProps.isRetry && alarmProps.retryCount > MAX_ALAEM_RETRIES) {
      // Only reschedule if there are pending tasks or container is running
      const hasScheduledTasks =
        this.sql`SELECT COUNT(*) as count FROM container_schedules`[0]?.count > 0;
      if (hasScheduledTasks || this.container.running) {
        await this.scheduleNextAlarm();
      }
      return;
    }

    await this.tryCatch(async () => {
      const now = Math.floor(Date.now() / 1000);

      // Get all schedules that should be executed now
      const result = this.sql<{
        id: string;
        callback: string;
        payload: string;
        type: 'scheduled' | 'delayed';
        time: number;
      }>`
        SELECT * FROM container_schedules;
      `;

      let maxTime = 0;

      // Process each due schedule
      for (const row of result) {
        if (row.time > now) {
          maxTime = Math.max(maxTime, row.time * 1000);
          continue;
        }

        const callback = this[row.callback as keyof this];

        if (!callback || typeof callback !== 'function') {
          console.error(`Callback ${row.callback} not found or is not a function`);
          continue;
        }

        // Create a schedule object for context
        const schedule = this.getSchedule(row.id);

        try {
          // Parse the payload and execute the callback
          const payload = row.payload ? JSON.parse(row.payload) : undefined;

          // Use context storage to execute the callback with proper 'this' binding
          await callback.call(this, payload, await schedule);
        } catch (e) {
          console.error(`Error executing scheduled callback "${row.callback}":`, e);
        }

        // Delete the schedule after execution (one-time schedules)
        this.sql`DELETE FROM container_schedules WHERE id = ${row.id}`;
      }

      await this.syncPendingStoppedEvents();

      // if not running and nothing to do, stop
      if (!this.container.running) {
        return;
      }

      // Only schedule next alarm if there are pending schedules or container is running
      const hasScheduledTasks =
        this.sql`SELECT COUNT(*) as count FROM container_schedules`[0]?.count > 0;
      if (hasScheduledTasks) {
        await this.scheduleNextAlarm();
      }

      if (this.isActivityExpired()) {
        await this.stopDueToInactivity();
        return;
      }

      let resolve = (_: unknown) => {};
      this.alarmSleepPromise = new Promise(res => {
        this.alarmSleepResolve = val => {
          // add here any debugging if you need to
          res(val);
        };

        resolve = res;
      });

      // Math.min(3m or maxTime, sleepTimeout)
      maxTime = maxTime === 0 ? Date.now() + 60 * 3 * 1000 : maxTime;
      maxTime = Math.min(maxTime, this.sleepAfterMs);
      const timeout = Math.max(0, maxTime - Date.now());
      const timeoutRef = setTimeout(() => {
        resolve('setTimeout');
      }, timeout);

      await this.alarmSleepPromise;
      clearTimeout(timeoutRef);
    });
  }


  // synchronises container state with the container source of truth to process events
  private async syncPendingStoppedEvents() {
    const state = await this.state.getState();
    if (!this.container.running && state.status === 'healthy') {
      await new Promise(res =>
        // setTimeout to process monitor() just in case
        setTimeout(async () => {
          await this.ctx.blockConcurrencyWhile(async () => {
            const newState = await this.state.getState();
            if (newState.status !== state.status) {
              // we got it, sync'd
              return;
            }

            // we lost the exit code! :(
            await this.onStop({ exitCode: 0, reason: 'exit' });
            await this.state.setStopped();
          });

          res(true);
        })
      );

      return;
    }

    if (!this.container.running && state.status === 'stopped_with_code') {
      await new Promise(res =>
        // setTimeout to process monitor() just in case
        setTimeout(async () => {
          await this.ctx.blockConcurrencyWhile(async () => {
            const newState = await this.state.getState();
            if (newState.status !== state.status) {
              // we got it, sync'd
              return;
            }

            await this.onStop({ exitCode: state.exitCode ?? 0, reason: 'exit' });
            await this.state.setStopped();
            res(true);
          });
        })
      );
      return;
    }
  }

  /**
   * Schedule the next alarm based on upcoming tasks
   * @private
   */
  private async scheduleNextAlarm(ms = 1000): Promise<void> {
    const existingAlarm = await this.ctx.storage.getAlarm();
    const nextTime = ms + Date.now();

    // if not already set
    if (existingAlarm === null || existingAlarm > nextTime || existingAlarm < Date.now()) {
      await this.ctx.storage.setAlarm(nextTime);
      await this.ctx.storage.sync();

      this.alarmSleepResolve('scheduling next alarm');
    }
  }

  /**
   * Get a scheduled task by ID
   * @template T Type of the payload data
   * @param id ID of the scheduled task
   * @returns The Schedule object or undefined if not found
   */
  async getSchedule<T = string>(id: string): Promise<Schedule<T> | undefined> {
    const result = this.sql<ScheduleSQL>`
      SELECT * FROM container_schedules WHERE id = ${id} LIMIT 1
    `;

    if (!result || result.length === 0) {
      return undefined;
    }

    const schedule = result[0];
    let payload: T;

    try {
      payload = JSON.parse(schedule.payload) as T;
    } catch (e) {
      console.error(`Error parsing payload for schedule ${id}:`, e);
      payload = undefined as unknown as T;
    }

    if (schedule.type === 'delayed') {
      return {
        taskId: schedule.id,
        callback: schedule.callback,
        payload,
        type: 'delayed',
        time: schedule.time,
        delayInSeconds: schedule.delayInSeconds!,
      };
    }

    return {
      taskId: schedule.id,
      callback: schedule.callback,
      payload,
      type: 'scheduled',
      time: schedule.time,
    };
  }

  private isActivityExpired(): boolean {
    return this.sleepAfterMs <= Date.now();
  }

  /**
   * Method called by scheduled task to stop the container due to inactivity
   */
  private async stopDueToInactivity(): Promise<void> {
    const alreadyStopped = !this.container.running;
    const hasOpenStream = this.openStreamCount > 0;

    if (alreadyStopped || hasOpenStream) {
      return;
    }

    await this.stop();
  }
}
