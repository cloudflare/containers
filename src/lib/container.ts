import type {
  ContainerOptions,
  ContainerStartOptions,
  ContainerStartConfigOptions,
  Schedule,
  StopParams,
  ScheduleSQL,
  State,
  WaitOptions,
  CancellationOptions,
  StartAndWaitForPortsOptions,
} from '../types';
import { generateId, parseTimeExpression } from './helpers';
import { DurableObject, waitUntil } from 'cloudflare:workers';

// ====================
// ====================
//      CONSTANTS
// ====================
// ====================

const NO_CONTAINER_INSTANCE_ERROR =
  'there is no container instance that can be provided to this durable object';
const RUNTIME_SIGNALLED_ERROR = 'runtime signalled the container to exit:';
const UNEXPECTED_EXIT_ERROR = 'container exited with unexpected exit code:';
const NOT_LISTENING_ERROR = 'the container is not listening';
const CONTAINER_STATE_KEY = '__CF_CONTAINER_STATE';

// maxRetries before scheduling next alarm is purposely set to 3,
// as according to DO docs at https://developers.cloudflare.com/durable-objects/api/alarms/
// the maximum amount for alarm retries is 6.
const MAX_ALARM_RETRIES = 3;
const PING_TIMEOUT_MS = 5000;

const DEFAULT_SLEEP_AFTER = '10m'; // Default sleep after inactivity time
const INSTANCE_POLL_INTERVAL_MS = 300; // Default interval for polling container state

// Timeout for getting container instance and launching a VM
// Time to find an instance, attach a DO, call start, but NOT
// the time for the app the actually start
const TIMEOUT_TO_GET_CONTAINER_MS = 8_000;

// Timeout for getting a container instance and launching
// the actual application and have it listen for specific ports
// One day might be configurable by the end user in Container class attribute
const TIMEOUT_TO_GET_PORTS_MS = 20_000;

// If user has specified no ports and we need to check one
// to see if the container is up at all.
const FALLBACK_PORT_TO_CHECK = 33;

export type Signal = 'SIGKILL' | 'SIGINT' | 'SIGTERM';
export type SignalInteger = number;
const signalToNumbers: Record<Signal, SignalInteger> = {
  SIGINT: 2,
  SIGTERM: 15,
  SIGKILL: 9,
};

// =====================
// =====================
//   HELPER FUNCTIONS
// =====================
// =====================

// ==== Error helpers ====

function isErrorOfType(e: unknown, matchingString: string): boolean {
  const errorString = e instanceof Error ? e.message : String(e);
  return errorString.toLowerCase().includes(matchingString);
}

const isNoInstanceError = (error: unknown): boolean =>
  isErrorOfType(error, NO_CONTAINER_INSTANCE_ERROR);
const isRuntimeSignalledError = (error: unknown): boolean =>
  isErrorOfType(error, RUNTIME_SIGNALLED_ERROR);
const isNotListeningError = (error: unknown): boolean => isErrorOfType(error, NOT_LISTENING_ERROR);
const isContainerExitNonZeroError = (error: unknown): boolean =>
  isErrorOfType(error, UNEXPECTED_EXIT_ERROR);

function getExitCodeFromError(error: unknown): number | null {
  if (!(error instanceof Error)) {
    return null;
  }

  if (isRuntimeSignalledError(error)) {
    return +error.message
      .toLowerCase()
      .slice(
        error.message.toLowerCase().indexOf(RUNTIME_SIGNALLED_ERROR) +
          RUNTIME_SIGNALLED_ERROR.length +
          1
      );
  }

  if (isContainerExitNonZeroError(error)) {
    return +error.message
      .toLowerCase()
      .slice(
        error.message.toLowerCase().indexOf(UNEXPECTED_EXIT_ERROR) +
          UNEXPECTED_EXIT_ERROR.length +
          1
      );
  }

  return null;
}

/**
 * Combines the existing user-defined signal with a signal that aborts after the timeout specified by waitInterval
 */
function addTimeoutSignal(existingSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const controller = new AbortController();

  // Forward existing signal abort
  if (existingSignal?.aborted) {
    controller.abort();
    return controller.signal;
  }

  existingSignal?.addEventListener('abort', () => controller.abort());

  // Add timeout
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // Clean up timeout if signal is aborted early
  controller.signal.addEventListener('abort', () => clearTimeout(timeoutId));

  return controller.signal;
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

    if (ctx.container === undefined) {
      throw new Error(
        'Containers have not been enabled for this Durable Object class. Have you correctly setup your Wrangler config? More info: https://developers.cloudflare.com/containers/get-started/#configuration'
      );
    }

    this.state = new ContainerState(this.ctx.storage);

    this.ctx.blockConcurrencyWhile(async () => {
      this.renewActivityTimeout();

      // First thing, schedule the next alarms
      await this.scheduleNextAlarm();
    });

    this.container = ctx.container;

    // Apply options if provided
    if (options) {
      if (options.defaultPort !== undefined) this.defaultPort = options.defaultPort;
      if (options.sleepAfter !== undefined) this.sleepAfter = options.sleepAfter;
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

    if (this.container.running) {
      this.monitor = this.container.monitor();
      this.setupMonitorCallbacks();
    }
  }

  /**
   * Gets the current state of the container
   * @returns Promise<State>
   */
  async getState(): Promise<State> {
    return { ...(await this.state.getState()) };
  }

  // ==========================
  //     CONTAINER STARTING
  // ==========================

  /**
   * Start the container if it's not running and set up monitoring and lifecycle hooks,
   * without waiting for ports to be ready.
   *
   * It will automatically retry if the container fails to start, using the specified waitOptions
   *
   *
   * @example
   * await this.start({
   *   envVars: { DEBUG: 'true', NODE_ENV: 'development' },
   *   entrypoint: ['npm', 'run', 'dev'],
   *   enableInternet: false
   * });
   *
   * @param startOptions - Override `envVars`, `entrypoint` and `enableInternet` on a per-instance basis
   * @param waitOptions - Optional wait configuration with abort signal for cancellation. Default ~8s timeout.
   * @returns A promise that resolves when the container start command has been issued
   * @throws Error if no container context is available or if all start attempts fail
   */
  public async start(
    startOptions?: ContainerStartConfigOptions,
    waitOptions?: WaitOptions
  ): Promise<void> {
    const portToCheck =
      waitOptions?.portToCheck ??
      this.defaultPort ??
      (this.requiredPorts ? this.requiredPorts[0] : FALLBACK_PORT_TO_CHECK);
    const pollInterval = waitOptions?.waitInterval ?? INSTANCE_POLL_INTERVAL_MS;
    await this.startContainerIfNotRunning(
      {
        signal: waitOptions?.signal,
        waitInterval: pollInterval,
        retries: waitOptions?.retries ?? Math.ceil(TIMEOUT_TO_GET_CONTAINER_MS / pollInterval),
        portToCheck,
      },
      startOptions
    );

    this.setupMonitorCallbacks();

    // TODO: We should consider an onHealthy callback
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.onStart();
    });
  }

  /**
   * Start the container and wait for ports to be available.
   *
   * For each specified port, it polls until the port is available or `cancellationOptions.portReadyTimeoutMS` is reached.
   *
   * @param ports - The ports to wait for (if undefined, uses requiredPorts or defaultPort)
   * @param cancellationOptions - Options to configure timeouts, polling intereva, and abort signal
   * @param startOptions Override configuration on a per-instance basis for env vars, entrypoint command and internet access
   * @returns A promise that resolves when the container has been started and the ports are listening
   * @throws Error if port checks fail after the specified timeout or if the container fails to start.
   */
  public async startAndWaitForPorts(args: StartAndWaitForPortsOptions): Promise<void>;
  public async startAndWaitForPorts(
    ports?: number | number[],
    cancellationOptions?: CancellationOptions,
    startOptions?: ContainerStartConfigOptions
  ): Promise<void>;
  public async startAndWaitForPorts(
    portsOrArgs?: number | number[] | StartAndWaitForPortsOptions,
    cancellationOptions?: CancellationOptions,
    startOptions?: ContainerStartConfigOptions
  ): Promise<void>;
  public async startAndWaitForPorts(
    portsOrArgs?: number | number[] | StartAndWaitForPortsOptions,
    cancellationOptions?: CancellationOptions,
    startOptions?: ContainerStartConfigOptions
  ): Promise<void> {
    // Parse arguments to handle different overload signatures
    let ports: number | number[] | undefined;
    let resolvedCancellationOptions: CancellationOptions | undefined = {};
    let resolvedStartOptions: ContainerStartConfigOptions | undefined = {};

    if (typeof portsOrArgs === 'object' && portsOrArgs !== null && !Array.isArray(portsOrArgs)) {
      // Object-based overload: { startOptions?, ports?, cancellationOptions? }
      ports = portsOrArgs.ports;
      resolvedCancellationOptions = portsOrArgs.cancellationOptions;
      resolvedStartOptions = portsOrArgs.startOptions;
    } else {
      ports = portsOrArgs;
      resolvedCancellationOptions = cancellationOptions;
      resolvedStartOptions = startOptions;
    }

    // Determine which ports to check
    const portsToCheck = await this.getPortsToCheck(ports);

    // trigger all onStop that we didn't do yet
    await this.syncPendingStoppedEvents();

    // Prepare to start the container
    resolvedCancellationOptions ??= {};
    const containerGetTimeout =
      resolvedCancellationOptions.instanceGetTimeoutMS ?? TIMEOUT_TO_GET_CONTAINER_MS;
    const pollInterval = resolvedCancellationOptions.waitInterval ?? INSTANCE_POLL_INTERVAL_MS;
    let containerGetRetries = Math.ceil(containerGetTimeout / pollInterval);

    const waitOptions: WaitOptions = {
      signal: resolvedCancellationOptions.abort,
      retries: containerGetRetries,
      waitInterval: pollInterval,
      portToCheck: portsToCheck[0],
    };

    // Start the container if it's not running
    const triesUsed = await this.startContainerIfNotRunning(waitOptions, resolvedStartOptions);

    // Check each port

    const totalPortReadyTries = Math.ceil(
      resolvedCancellationOptions.portReadyTimeoutMS ?? TIMEOUT_TO_GET_PORTS_MS / pollInterval
    );
    let triesLeft = totalPortReadyTries - triesUsed;

    for (const port of portsToCheck) {
      triesLeft = await this.waitForPort({
        signal: resolvedCancellationOptions.abort,
        waitInterval: pollInterval,
        retries: triesLeft,
        portToCheck: port,
      });
    }

    this.setupMonitorCallbacks();

    await this.ctx.blockConcurrencyWhile(async () => {
      // All ports are ready
      await this.state.setHealthy();
      await this.onStart();
    });
  }

  /**
   *
   * Waits for a specified port to be ready
   *
   * Returns the number of tries used to get the port, or throws if it couldn't get the port within the specified retry limits.
   *
   * @param waitOptions -
   * - `portToCheck`: The port number to check
   * - `abort`: Optional AbortSignal to cancel waiting
   * - `retries`: Number of retries before giving up (default: TRIES_TO_GET_PORTS)
   * - `waitInterval`: Interval between retries in milliseconds (default: INSTANCE_POLL_INTERVAL_MS)
   */
  public async waitForPort(waitOptions: WaitOptions): Promise<number> {
    const port = waitOptions.portToCheck;
    const tcpPort = this.container.getTcpPort(port);
    const abortedSignal = new Promise(res => {
      waitOptions.signal?.addEventListener('abort', () => {
        res(true);
      });
    });
    const pollInterval = waitOptions.waitInterval ?? INSTANCE_POLL_INTERVAL_MS;
    let tries = waitOptions.retries ?? Math.ceil(TIMEOUT_TO_GET_PORTS_MS / pollInterval);

    // Try to connect to the port multiple times
    for (let i = 0; i < tries; i++) {
      try {
        const combinedSignal = addTimeoutSignal(waitOptions.signal, PING_TIMEOUT_MS);
        await tcpPort.fetch('http://ping', { signal: combinedSignal });

        // Successfully connected to this port
        console.log(`Port ${port} is ready`);
        break;
      } catch (e) {
        // Check for specific error messages that indicate we should keep retrying
        const errorMessage = e instanceof Error ? e.message : String(e);

        console.debug(`Error checking ${port}: ${errorMessage}`);

        // If not running, it means the container crashed
        if (!this.container.running) {
          try {
            await this.onError(
              new Error(
                `Container crashed while checking for ports, did you start the container and setup the entrypoint correctly?`
              )
            );
          } catch {}

          throw e;
        }

        // If we're on the last attempt and the port is still not ready, fail
        if (i === tries - 1) {
          try {
            await this.onError(
              `Failed to verify port ${port} is available after ${(i + 1) * pollInterval}ms, last error: ${errorMessage}`
            );
          } catch {}
          throw e;
        }

        // Wait a bit before trying again
        await Promise.any([
          new Promise(resolve => setTimeout(resolve, waitOptions.waitInterval)),
          abortedSignal,
        ]);
        if (waitOptions.signal?.aborted) {
          throw new Error('Container request aborted.');
        }
      }
    }
    return tries;
  }
  // =======================
  //     LIFECYCLE HOOKS
  // =======================

  /**
   * Send a signal to the container.
   * @param signal - The signal to send to the container (default: 15 for SIGTERM)
   */
  public async stop(signal: Signal | SignalInteger = 'SIGTERM'): Promise<void> {
    if (this.container.running) {
      this.container.signal(typeof signal === 'string' ? signalToNumbers[signal] : signal);
    }
    await this.syncPendingStoppedEvents();
  }

  /**
   * Destroys the container with a SIGKILL. Triggers onStop.
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
   * Lifecycle method called when the container is running, and the activity timeout
   * expiration (set by `sleepAfter`) has been reached.
   *
   * If you want to shutdown the container, you should call this.stop() here
   *
   * By default, this method calls `this.stop()`
   */
  public async onActivityExpired(): Promise<void> {
    if (!this.container.running) {
      return;
    }

    await this.stop();
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
   * Schedule a task to be executed in the future.
   *
   * We strongly recommend using this instead of the `alarm` handler.
   *
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
   *
   * This method handles HTTP requests to the container.
   *
   * WebSocket requests done outside the DO won't work until https://github.com/cloudflare/workerd/issues/2319 is addressed.
   * Until then, please use `switchPort` + `fetch()`.
   *
   * Method supports multiple signatures to match standard fetch API:
   * - containerFetch(request: Request, port?: number)
   * - containerFetch(url: string | URL, init?: RequestInit, port?: number)
   *
   * Starts the container if not already running, and waits for the target port to be ready.
   *
   * @returns A Response from the container
   */
  public async containerFetch(
    requestOrUrl: Request | string | URL,
    portOrInit?: number | RequestInit,
    portParam?: number
  ): Promise<Response> {
    // Parse the arguments based on their types to handle different method signatures
    let { request, port } = this.requestAndPortFromContainerFetchArgs(
      requestOrUrl,
      portOrInit,
      portParam
    );

    const state = await this.state.getState();
    if (!this.container.running || state.status !== 'healthy') {
      try {
        await this.startAndWaitForPorts(port, { abort: request.signal });
      } catch (e) {
        if (isNoInstanceError(e)) {
          return new Response(
            'There is no Container instance available at this time.\nThis is likely because you have reached your max concurrent instance count (set in wrangler config) or are you currently provisioning the Container.\nIf you are deploying your Container for the first time, check your dashboard to see provisioning status, this may take a few minutes.',
            { status: 503 }
          );
        } else {
          return new Response(
            `Failed to start container: ${e instanceof Error ? e.message : String(e)}`,
            { status: 500 }
          );
        }
      }
    }

    const tcpPort = this.container.getTcpPort(port);

    // Create URL for the container request
    const containerUrl = request.url.replace('https:', 'http:');

    try {
      // Renew the activity timeout whenever a request is proxied
      this.renewActivityTimeout();
      const res = await tcpPort.fetch(containerUrl, request);
      return res;
    } catch (e) {
      if (!(e instanceof Error)) {
        throw e;
      }

      // This error means that the container might've just restarted
      if (e.message.includes('Network connection lost.')) {
        return new Response('Container suddenly disconnected, try again', { status: 500 });
      }

      console.error(`Error proxying request to container ${this.ctx.id}:`, e);
      return new Response(
        `Error proxying request to container: ${e instanceof Error ? e.message : String(e)}`,
        { status: 500 }
      );
    }
  }

  /**
   *
   * Fetch handler on the Container class.
   * By default this forwards all requests to the container by calling `containerFetch`.
   * Use `switchPort` to specify which port on the container to target, or this will use `defaultPort`.
   * @param request The request to handle
   */
  override async fetch(request: Request): Promise<Response> {
    if (this.defaultPort === undefined && !request.headers.has('cf-container-target-port')) {
      throw new Error(
        'No port configured for this container. Set the `defaultPort` in your Container subclass, or specify a port with `container.fetch(switchPort(request, port))`.'
      );
    }

    let portValue = this.defaultPort;

    if (request.headers.has('cf-container-target-port')) {
      const portFromHeaders = parseInt(request.headers.get('cf-container-target-port') ?? '');
      if (isNaN(portFromHeaders)) {
        throw new Error('port value from switchPort is not a number');
      } else {
        portValue = portFromHeaders;
      }
    }
    // Forward all requests (HTTP and WebSocket) to the container
    return await this.containerFetch(request, portValue);
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
  // onStopCalled will be true when we are in the middle of an onStop call
  private onStopCalled = false;
  private state: ContainerState;
  private monitor: Promise<unknown> | undefined;

  private monitorSetup = false;

  private sleepAfterMs = 0;

  // ==========================
  //     GENERAL HELPERS
  // ==========================

  /**
   * Execute SQL queries against the Container's database
   */
  private sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ) {
    let query = '';
    // Construct the SQL query with placeholders
    query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? '?' : ''), '');

    // Execute the SQL query with the provided values
    return [...this.ctx.storage.sql.exec(query, ...values)] as T[];
  }

  private requestAndPortFromContainerFetchArgs(
    requestOrUrl: Request | string | URL,
    portOrInit?: number | RequestInit,
    portParam?: number
  ): { request: Request; port: number } {
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
    port ??= this.defaultPort;
    // Require a port to be specified, either as a parameter or as a defaultPort property
    if (port === undefined) {
      throw new Error(
        'No port specified for container fetch. Set defaultPort or specify a port parameter.'
      );
    }

    return { request, port };
  }

  /**
   *
   * The method prioritizes port sources in this order:
   * 1. Ports specified directly in the method call
   * 2. `requiredPorts` class property (if set)
   * 3. `defaultPort` (if neither of the above is specified)
   * 4. Falls back to port 33 if none of the above are set
   */
  private async getPortsToCheck(overridePorts?: number | number[]) {
    let portsToCheck: number[] = [];

    if (overridePorts !== undefined) {
      // Use explicitly provided ports (single port or array)
      portsToCheck = Array.isArray(overridePorts) ? overridePorts : [overridePorts];
    } else if (this.requiredPorts && this.requiredPorts.length > 0) {
      // Use requiredPorts class property if available
      portsToCheck = [...this.requiredPorts];
    } else {
      // Fall back to defaultPort if available
      portsToCheck = [this.defaultPort ?? FALLBACK_PORT_TO_CHECK];
    }

    return portsToCheck;
  }

  // ===========================================
  //     CONTAINER INTERACTION & MONITORING
  // ===========================================

  /**
   * Tries to start a container if it's not already running
   * Returns the number of tries used
   */
  private async startContainerIfNotRunning(
    waitOptions: WaitOptions,
    options?: ContainerStartConfigOptions
  ): Promise<number> {
    // Start the container if it's not running
    if (this.container.running) {
      if (!this.monitor) {
        this.monitor = this.container.monitor();
      }

      return 0;
    }

    const abortedSignal = new Promise(res => {
      waitOptions.signal?.addEventListener('abort', () => {
        res(true);
      });
    });
    const pollInterval = waitOptions.waitInterval ?? INSTANCE_POLL_INTERVAL_MS;
    const totalTries = waitOptions.retries ?? Math.ceil(TIMEOUT_TO_GET_CONTAINER_MS / pollInterval);
    await this.state.setRunning();
    for (let tries = 0; tries < totalTries; tries++) {
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
            `Container exited before we could determine the container health, exit code: ${err}`
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

      if (tries > 0 && !this.container.running) {
        await handleError();
      }

      await this.scheduleNextAlarm();

      if (!this.container.running) {
        this.container.start(startConfig);
        this.monitor = this.container.monitor();
      } else {
        await this.scheduleNextAlarm();
      }

      this.renewActivityTimeout();

      // TODO: Make this the port I'm trying to get!
      const port = this.container.getTcpPort(waitOptions.portToCheck);
      try {
        const combinedSignal = addTimeoutSignal(waitOptions.signal, PING_TIMEOUT_MS);
        await port.fetch('http://containerstarthealthcheck', { signal: combinedSignal });
        return tries;
      } catch (error) {
        if (isNotListeningError(error) && this.container.running) {
          return tries;
        }

        if (!this.container.running && isNotListeningError(error)) {
          await handleError();
        }

        console.debug(
          'Error checking if container is ready:',
          error instanceof Error ? error.message : String(error)
        );

        await Promise.any([
          new Promise(res => setTimeout(res, waitOptions.waitInterval)),
          abortedSignal,
        ]);

        if (waitOptions.signal?.aborted) {
          throw new Error(
            'Aborted waiting for container to start as we received a cancellation signal'
          );
        }

        // TODO: Make this error specific to this, but then catch it above w something else
        if (totalTries === tries + 1) {
          if (error instanceof Error && error.message.includes('Network connection lost')) {
            // We have to abort here, the reasoning is that we might've found
            // ourselves in an internal error where the Worker is stuck with a failed connection to the
            // container services.
            //
            // Until we address this issue on the back-end CF side, we will need to abort the
            // durable object so it retries to reconnect from scratch.
            this.ctx.abort();
          }

          throw new Error(NO_CONTAINER_INSTANCE_ERROR);
        }

        continue;
      }
    }

    throw new Error(`Container did not start after ${totalTries * pollInterval}ms`);
  }

  private setupMonitorCallbacks() {
    if (this.monitorSetup) {
      return;
    }

    this.monitorSetup = true;
    this.monitor
      ?.then(async () => {
        await this.ctx.blockConcurrencyWhile(async () => {
          await this.state.setStoppedWithCode(0);
        });
      })
      .catch(async (error: unknown) => {
        if (isNoInstanceError(error)) {
          // we will inform later
          return;
        }

        const exitCode = getExitCodeFromError(error);
        if (exitCode !== null) {
          await this.state.setStoppedWithCode(exitCode);
          this.monitorSetup = false;
          this.monitor = undefined;
          return;
        }

        try {
          // TODO: Be able to retrigger onError
          await this.onError(error);
        } catch {}
      })
      .finally(() => {
        this.monitorSetup = false;
        if (this.timeout) {
          if (this.resolve) this.resolve();
          clearTimeout(this.timeout);
        }
      });
  }

  deleteSchedules(name: string) {
    this.sql`DELETE FROM container_schedules WHERE callback = ${name}`;
  }

  // ============================
  //     ALARMS AND SCHEDULES
  // ============================

  /**
   * Method called when an alarm fires
   * Executes any scheduled tasks that are due
   */

  override async alarm(alarmProps: { isRetry: boolean; retryCount: number }): Promise<void> {
    if (alarmProps.isRetry && alarmProps.retryCount > MAX_ALARM_RETRIES) {
      const scheduleCount =
        Number(this.sql`SELECT COUNT(*) as count FROM container_schedules`[0]?.count) || 0;
      const hasScheduledTasks = scheduleCount > 0;
      if (hasScheduledTasks || this.container.running) {
        await this.scheduleNextAlarm();
      }
      return;
    }

    // do not remove this, container DOs ALWAYS need an alarm right now.
    // The only way for this DO to stop having alarms is:
    //  1. The container is not running anymore.
    //  2. Activity expired and it exits.
    const prevAlarm = Date.now();
    await this.ctx.storage.setAlarm(prevAlarm);
    await this.ctx.storage.sync();

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
    let minTime = Date.now() + 3 * 60 * 1000;

    const now = Date.now() / 1000;
    // Process each due schedule
    for (const row of result) {
      // check if we need to run it
      if (row.time > now) {
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

    const resultForMinTime = this.sql<{
      id: string;
      callback: string;
      payload: string;
      type: 'scheduled' | 'delayed';
      time: number;
    }>`
         SELECT * FROM container_schedules;
       `;
    const minTimeFromSchedules = Math.min(...resultForMinTime.map(r => r.time * 1000));

    // if not running and nothing to do, stop
    if (!this.container.running) {
      await this.syncPendingStoppedEvents();

      if (resultForMinTime.length == 0) {
        await this.ctx.storage.deleteAlarm();
      } else {
        await this.ctx.storage.setAlarm(minTimeFromSchedules);
      }

      return;
    }

    if (this.isActivityExpired()) {
      await this.onActivityExpired();
      // renewActivityTimeout makes sure we don't spam calls here
      this.renewActivityTimeout();
      return;
    }

    // Math.min(3m or maxTime, sleepTimeout)
    minTime = Math.min(minTimeFromSchedules, minTime, this.sleepAfterMs);
    const timeout = Math.max(0, minTime - Date.now());

    // await a sleep for maxTime to keep the DO alive for
    // at least this long
    await new Promise<void>(resolve => {
      this.resolve = resolve;
      if (!this.container.running) {
        resolve();
        return;
      }

      this.timeout = setTimeout(() => {
        resolve();
      }, timeout);
    });

    await this.ctx.storage.setAlarm(Date.now());

    // we exit and we have another alarm,
    // the next alarm is the one that decides if it should stop the loop.
  }

  timeout?: ReturnType<typeof setTimeout>;
  resolve?: () => void;

  // synchronises container state with the container source of truth to process events
  private async syncPendingStoppedEvents() {
    const state = await this.state.getState();
    if (!this.container.running && state.status === 'healthy') {
      await this.callOnStop({ exitCode: 0, reason: 'exit' });
      return;
    }

    if (!this.container.running && state.status === 'stopped_with_code') {
      await this.callOnStop({ exitCode: state.exitCode ?? 0, reason: 'exit' });
      return;
    }
  }

  private async callOnStop(onStopParams: StopParams) {
    if (this.onStopCalled) {
      return;
    }

    this.onStopCalled = true;
    const promise = this.onStop(onStopParams);
    if (promise instanceof Promise) {
      await promise.finally(() => {
        this.onStopCalled = false;
      });
    } else {
      this.onStopCalled = false;
    }

    await this.state.setStopped();
  }

  /**
   * Schedule the next alarm based on upcoming tasks
   */
  public async scheduleNextAlarm(ms = 1000): Promise<void> {
    const nextTime = ms + Date.now();

    // if not already set
    if (this.timeout) {
      if (this.resolve) this.resolve();
      clearTimeout(this.timeout);
    }

    await this.ctx.storage.setAlarm(nextTime);
    await this.ctx.storage.sync();
  }

  async listSchedules<T = string>(name: string): Promise<Schedule<T>[]> {
    const result = this.sql<ScheduleSQL>`
      SELECT * FROM container_schedules WHERE callback = ${name} LIMIT 1
    `;

    if (!result || result.length === 0) {
      return [];
    }

    return result.map(this.toSchedule<T>);
  }

  private toSchedule<T = string>(schedule: ScheduleSQL): Schedule<T> {
    let payload: T;
    try {
      payload = JSON.parse(schedule.payload) as T;
    } catch (e) {
      console.error(`Error parsing payload for schedule ${schedule.id}:`, e);
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
    return this.toSchedule(schedule);
  }

  private isActivityExpired(): boolean {
    return this.sleepAfterMs <= Date.now();
  }
}
