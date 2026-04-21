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
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';

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
const OUTBOUND_CONFIGURATION_KEY = 'OUTBOUND_CONFIGURATION';

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

export type OutboundHandlerContext<Params = unknown> = {
  containerId: string;
  className: string;
} & ([Params] extends [undefined]
  ? { params?: undefined }
  : undefined extends Params
    ? { params?: Params }
    : { params: Params });

type OutboundParamsArg<Params> = [Params] extends [undefined]
  ? []
  : undefined extends Params
    ? [params?: Params]
    : [params: Params];

export type OutboundHandler<E = Cloudflare.Env, P = unknown> = {
  bivarianceHack(
    req: Request,
    env: E,
    ctx: OutboundHandlerContext<P>
  ): Promise<Response> | Response;
}['bivarianceHack'];

export type OutboundHandlerParams = Record<string, unknown>;

export type OutboundHandlerParamsOf<THandler> = THandler extends (
  req: Request,
  env: unknown,
  ctx: OutboundHandlerContext<infer Params>
) => Promise<Response> | Response
  ? Params
  : never;

export function outboundParams<THandler extends OutboundHandler<unknown, unknown>>(
  _handler: THandler,
  params: OutboundHandlerParamsOf<THandler>
): OutboundHandlerParamsOf<THandler> {
  return params;
}

export type OutboundHandlers<ParamsByMethod extends OutboundHandlerParams, E = Cloudflare.Env> = {
  [Method in keyof ParamsByMethod]?: OutboundHandler<E, ParamsByMethod[Method]>;
};

type OutboundHandlerOverride<Params = unknown> = {
  method: string;
} & ([Params] extends [undefined]
  ? { params?: undefined }
  : undefined extends Params
    ? { params?: Params }
    : { params: Params });

type OutboundByHostOverrides = Record<string, OutboundHandlerOverride>;

type OutboundByHostOverrideInput<Params = unknown> = Record<
  string,
  string | OutboundHandlerOverride<Params>
>;

// class name to named outbound handlers (includes the default outbound handler)
const outboundHandlersRegistry = new Map<string, Record<string, OutboundHandler>>();

// class name to default catch-all outbound handler method name in outboundHandlersRegistry
const defaultOutboundHandlerNameRegistry = new Map<string, string>();

// class name to hostname to default outbound handler function
const outboundByHostRegistry = new Map<string, Record<string, OutboundHandler>>();

export type Signal = 'SIGKILL' | 'SIGINT' | 'SIGTERM';
export type SignalInteger = number;
const signalToNumbers: Record<Signal, SignalInteger> = {
  SIGINT: 2,
  SIGTERM: 15,
  SIGKILL: 9,
};

/**
 * Options passed into a ReadinessCheck when it's invoked.
 */
export interface ReadinessCheckOptions {
  /** Optional abort signal to cancel the check */
  signal?: AbortSignal;
}

/**
 * A readiness check is a function that returns a promise.
 * The Container will wait for every declared readiness check to resolve
 * before allowing fetch requests to be proxied to the container.
 *
 * Checks receive the container instance (so helpers like `portResponding`
 * can poll the right TCP port) and an options bag with an optional abort
 * signal so long-running checks can cooperatively abort.
 *
 * A check passes by resolving. It fails by rejecting — readiness will
 * then reject as a whole, which surfaces as a 500 from `containerFetch`.
 */
export type ReadinessCheck = (
  // Using a minimal structural type here avoids generic friction when a
  // `Container<SomeEnv>` subclass passes `this` to a check expecting the
  // unparameterized Container.
  container: Container<any>,
  options?: ReadinessCheckOptions
) => Promise<unknown>;

/**
 * Readiness check that waits for the given port to start accepting HTTP
 * connections. Any HTTP response (including 4xx) counts as "responding" —
 * the goal is to confirm the process has bound the port.
 *
 * @example
 * class MyApp extends Container {
 *   readyOn = [portResponding(8080)];
 * }
 */
export function portResponding(port: number): ReadinessCheck {
  return (container, options) =>
    container.waitForPort({ portToCheck: port, signal: options?.signal });
}

/**
 * Readiness check that polls an HTTP path until it returns a 2xx response.
 * Useful for apps that expose a `/health` or `/ready` endpoint.
 *
 * If `port` is omitted, the container's `defaultPort` is used. If neither
 * is set, the check throws when it runs.
 *
 * @example
 * class MyApp extends Container {
 *   defaultPort = 8080;
 *   readyOn = [isHealthy('/health')];
 * }
 */
export function isHealthy(path: string, port?: number): ReadinessCheck {
  return (container, options) => {
    const targetPort = port ?? container.defaultPort;
    if (targetPort === undefined) {
      return Promise.reject(
        new Error(`isHealthy('${path}'): no port specified and no defaultPort set on the container`)
      );
    }
    return container.waitForPath({ path, portToCheck: targetPort, signal: options?.signal });
  };
}

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

type ContainerProxyOptions = {
  enableInternet?: boolean;
  containerId: string;
  className: string;
  outboundByHostOverrides?: OutboundByHostOverrides;
  outboundHandlerOverride?: OutboundHandlerOverride;
};

type PersistedOutboundConfiguration = Pick<
  ContainerProxyOptions,
  'enableInternet' | 'outboundByHostOverrides' | 'outboundHandlerOverride'
>;

export class ContainerProxy extends WorkerEntrypoint<Cloudflare.Env, ContainerProxyOptions> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const {
      className,
      containerId,
      outboundByHostOverrides,
      outboundHandlerOverride,
      enableInternet,
    } = this.ctx.props;
    const handlers = outboundHandlersRegistry.get(className);
    const baseCtx = { containerId, className };

    // Runtime handler override takes priority over static outboundByHost
    const outboundByHostOverride = outboundByHostOverrides?.[url.hostname];
    if (outboundByHostOverride && handlers?.[outboundByHostOverride.method]) {
      return handlers[outboundByHostOverride.method](request, this.env, {
        ...baseCtx,
        params: outboundByHostOverride.params,
      });
    }

    // Static outboundByHost
    const handlersByHost = outboundByHostRegistry.get(className);
    if (handlersByHost && url.hostname in handlersByHost) {
      return handlersByHost[url.hostname](request, this.env, baseCtx);
    }

    // Runtime catch-all handler override
    if (outboundHandlerOverride && handlers?.[outboundHandlerOverride.method]) {
      return handlers[outboundHandlerOverride.method](request, this.env, {
        ...baseCtx,
        params: outboundHandlerOverride.params,
      });
    }

    // Default catch-all handler (static outbound)
    const defaultOutboundHandlerName = defaultOutboundHandlerNameRegistry.get(className);
    if (defaultOutboundHandlerName && handlers?.[defaultOutboundHandlerName]) {
      return handlers[defaultOutboundHandlerName](request, this.env, baseCtx);
    }

    // enableInternet fallback
    if (enableInternet) {
      return fetch(request);
    }

    return new Response('Origin is disallowed', { status: 520 });
  }
}

// ===============================
// ===============================
//     MAIN CONTAINER CLASS
// ===============================
// ===============================
//

export class Container<Env = Cloudflare.Env> extends DurableObject<Env> {
  static get outboundByHost(): Record<string, OutboundHandler> | undefined {
    return outboundByHostRegistry.get(this.name);
  }

  static set outboundByHost(handlers: Record<string, OutboundHandler>) {
    outboundByHostRegistry.set(this.name, handlers);
  }

  static get outboundHandlers(): Record<string, OutboundHandler> | undefined {
    return outboundHandlersRegistry.get(this.name);
  }

  static set outboundHandlers(handlers: Record<string, OutboundHandler>) {
    const existing = outboundHandlersRegistry.get(this.name) ?? {};
    outboundHandlersRegistry.set(this.name, { ...existing, ...handlers });
  }

  static get outbound(): OutboundHandler | undefined {
    const handlerName = defaultOutboundHandlerNameRegistry.get(this.name);
    if (!handlerName) return undefined;
    return outboundHandlersRegistry.get(this.name)?.[handlerName];
  }

  static set outbound(handler: OutboundHandler) {
    const key = '__outbound__';
    const existing = outboundHandlersRegistry.get(this.name) ?? {};
    outboundHandlersRegistry.set(this.name, { ...existing, [key]: handler });
    defaultOutboundHandlerNameRegistry.set(this.name, key);
  }

  static get outboundProxies(): Record<string, OutboundHandler> | undefined {
    return this.outboundHandlers;
  }

  static set outboundProxies(handlers: Record<string, OutboundHandler>) {
    this.outboundHandlers = handlers;
  }

  static get outboundProxy(): OutboundHandler | undefined {
    return this.outbound;
  }

  static set outboundProxy(handler: OutboundHandler) {
    this.outbound = handler;
  }

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

  // pingEndpoint is the host and path value that the class will use to send a request to the container and check if the
  // instance is ready.
  //
  // The user does not have to implement this route by any means,
  // but it's still useful if you want to control the path that
  // the Container class uses to send HTTP requests to.
  pingEndpoint: string = 'ping';

  /**
   * Readiness checks that must all resolve before fetch requests are
   * allowed through to the container.
   *
   * `portResponding` checks for `defaultPort` and every `requiredPorts`
   * entry are added automatically — you don't need to list them here.
   *
   * @example
   * class MyApp extends Container {
   *   defaultPort = 8080;
   *   // portResponding(8080) is added automatically
   *   readyOn = [isHealthy('/health')];
   * }
   *
   * @example
   * class MyApp extends Container {
   *   requiredPorts = [8080, 8081];
   *   // portResponding(8080) and portResponding(8081) are added automatically
   *   readyOn = [isHealthy('/health', 8080)];
   * }
   *
   * Use `addReadinessCheck(...)` to add a check at runtime, or
   * `setReadinessChecks([...])` to take full control (auto port checks
   * are NOT added when `setReadinessChecks` is used — include them
   * explicitly if you need them). Pass `setReadinessChecks([])` to opt
   * out entirely.
   *
   * Checks run in parallel, so ordering does not matter. If any check
   * rejects, the container is not considered ready.
   */
  readyOn?: ReadinessCheck[];

  applyOutboundInterceptionPromise: Promise<void> = Promise.resolve();

  usingInterception = false;

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
    const persistedOutboundConfiguration = this.restoreOutboundConfiguration();
    const ctor = this.constructor as typeof Container;
    if (
      persistedOutboundConfiguration !== undefined ||
      ctor.outboundByHost !== undefined ||
      ctor.outbound !== undefined ||
      ctor.outboundHandlers !== undefined
    ) {
      this.usingInterception = true;
      this.applyOutboundInterceptionPromise = this.applyOutboundInterception();
    }

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

  // ====================================
  //     OUTBOUND INTERCEPTION CONFIG
  // ====================================

  /**
   * Set the catch-all outbound handler to a named method from `outboundHandlers`.
   * Overrides the default `outbound` at runtime via ContainerProxy props.
   *
   * @param methodName - Name of a method defined in `static outboundHandlers`
   * @param params - Optional params passed to the handler as `ctx.params`
   * @throws Error if the method name is not found in `outboundHandlers`
   */
  async setOutboundHandler<Params = unknown>(
    methodName: string,
    ...paramsArg: OutboundParamsArg<Params>
  ): Promise<void> {
    this.validateOutboundHandlerMethodName(methodName);
    this.outboundHandlerOverride =
      paramsArg.length === 0
        ? { method: methodName }
        : { method: methodName, params: paramsArg[0] };
    await this.refreshOutboundInterception();
  }

  /**
   * Add or override a hostname-specific outbound handler at runtime,
   * referencing a named method from `outboundHandlers`.
   * Overrides any matching entry in `static outboundByHost` for this hostname.
   *
   * @param hostname - The hostname or ip:port to intercept (e.g. `'google.com'`)
   * @param methodName - Name of a method defined in `static outboundHandlers`
   * @param params - Optional params passed to the handler as `ctx.params`
   * @throws Error if the method name is not found in `outboundHandlers`
   */
  async setOutboundByHost<Params = unknown>(
    hostname: string,
    methodName: string,
    ...paramsArg: OutboundParamsArg<Params>
  ): Promise<void> {
    this.validateOutboundHandlerMethodName(methodName);
    this.outboundByHostOverrides[hostname] =
      paramsArg.length === 0
        ? { method: methodName }
        : { method: methodName, params: paramsArg[0] };
    await this.refreshOutboundInterception();
  }

  /**
   * Remove a runtime hostname override added via `setOutboundByHost`.
   * The default handler from `static outboundByHost` (if any) will be used again.
   *
   * @param hostname - The hostname or ip:port to stop overriding
   */
  async removeOutboundByHost(hostname: string): Promise<void> {
    delete this.outboundByHostOverrides[hostname];
    await this.refreshOutboundInterception();
  }

  /**
   * Replace all runtime hostname overrides at once.
   * Each value may be either a method name or an object with `method` and `params`.
   *
   * @param handlers - Record mapping hostnames to handler configs in `outboundHandlers`
   * @throws Error if any method name is not found in `outboundHandlers`
   */
  async setOutboundByHosts<Params = unknown>(
    handlers: OutboundByHostOverrideInput<Params>
  ): Promise<void> {
    for (const handler of Object.values(handlers)) {
      const methodName = typeof handler === 'string' ? handler : handler.method;
      this.validateOutboundHandlerMethodName(methodName);
    }

    this.outboundByHostOverrides = Object.fromEntries(
      Object.entries(handlers).map(([hostname, handler]) => [
        hostname,
        typeof handler === 'string' ? { method: handler } : handler,
      ])
    );
    await this.refreshOutboundInterception();
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
   * Start the container and wait for it to become ready.
   *
   * Readiness is determined by the container's `readyOn` list. If
   * `readyOn` is undefined, a default list derived from `defaultPort` /
   * `requiredPorts` is used — equivalent to the historical "wait for
   * ports" behaviour.
   *
   * All readiness checks run in parallel. The method resolves once every
   * check resolves, or rejects on the first failure.
   *
   * @param ports - If provided, overrides `readyOn` and waits for just
   *   these ports (useful for ad-hoc ports not declared on the class)
   * @param cancellationOptions - Timeouts, polling interval, and abort
   * @param startOptions - Override env vars / entrypoint / internet access
   * @returns Resolves when the container is running and ready
   * @throws If the container fails to start, any readiness check fails,
   *   or the timeout is exceeded
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

    // trigger all onStop that we didn't do yet
    await this.syncPendingStoppedEvents();

    resolvedCancellationOptions ??= {};
    const containerGetTimeout =
      resolvedCancellationOptions.instanceGetTimeoutMS ?? TIMEOUT_TO_GET_CONTAINER_MS;
    const pollInterval = resolvedCancellationOptions.waitInterval ?? INSTANCE_POLL_INTERVAL_MS;
    const containerGetRetries = Math.ceil(containerGetTimeout / pollInterval);

    // Explicit ports override the configured readiness checks; otherwise
    // use `readyOn` (or the default derived from defaultPort/requiredPorts).
    const readinessChecks =
      ports !== undefined
        ? (Array.isArray(ports) ? ports : [ports]).map(p => portResponding(p))
        : this.getReadinessChecks();

    // The initial port probe (during startContainerIfNotRunning) needs a
    // concrete port — use an explicit one, the first required port, the
    // default port, or a fallback. This is just to verify the container
    // process is reachable; readiness checks run after.
    const probePort = await this.getProbePort(ports);

    const waitOptions: WaitOptions = {
      signal: resolvedCancellationOptions.abort,
      retries: containerGetRetries,
      waitInterval: pollInterval,
      portToCheck: probePort,
    };

    // Start the container if it's not running
    await this.startContainerIfNotRunning(waitOptions, resolvedStartOptions);

    // Run readiness checks in parallel, bounded by portReadyTimeoutMS
    const readyTimeoutMs =
      resolvedCancellationOptions.portReadyTimeoutMS ?? TIMEOUT_TO_GET_PORTS_MS;
    await this.runReadinessChecks(readinessChecks, {
      signal: resolvedCancellationOptions.abort,
      timeoutMs: readyTimeoutMs,
    });

    this.setupMonitorCallbacks();

    await this.ctx.blockConcurrencyWhile(async () => {
      // All readiness checks passed
      await this.state.setHealthy();
      await this.onStart();
    });
  }

  /**
   * Append a readiness check to `readyOn`.
   *
   * Automatic `portResponding` checks for `defaultPort` / `requiredPorts`
   * are preserved — this adds to them rather than replacing. Use
   * `setReadinessChecks` if you need full control.
   *
   * @example
   * // defaultPort = 8080, no readyOn declared on the class.
   * // Effective checks after this call:
   * //   [portResponding(8080), isHealthy('/ready')]
   * container.addReadinessCheck(isHealthy('/ready'));
   *
   * @example
   * // Add a one-off warmup check:
   * container.addReadinessCheck(async () => {
   *   await warmCachesFromR2();
   * });
   */
  public addReadinessCheck(check: ReadinessCheck): void {
    if (this.readyOn === undefined) {
      this.readyOn = [];
    }
    this.readyOn.push(check);
  }

  /**
   * Replace the readiness check list with the provided one.
   *
   * Unlike `readyOn` and `addReadinessCheck`, this takes full control:
   * automatic `portResponding` checks for `defaultPort` / `requiredPorts`
   * are NOT added. If you want port checks, include them explicitly.
   *
   * Pass an empty array to opt out of readiness checking entirely — the
   * container is considered ready as soon as it starts.
   *
   * @example
   * // Replace everything, including any auto port checks:
   * container.setReadinessChecks([
   *   portResponding(8080),
   *   isHealthy('/ready'),
   *   async () => { await migrateDatabase(); },
   * ]);
   *
   * @example
   * // Opt out — ready immediately once the process starts:
   * container.setReadinessChecks([]);
   */
  public setReadinessChecks(checks: ReadinessCheck[]): void {
    this.readyOn = [...checks];
    this.readinessChecksReplaced = true;
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
        await tcpPort.fetch(`http://${this.pingEndpoint}`, { signal: combinedSignal });

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
          new Promise(resolve => setTimeout(resolve, pollInterval)),
          abortedSignal,
        ]);
        if (waitOptions.signal?.aborted) {
          throw new Error('Container request aborted.');
        }
      }
    }
    return tries;
  }

  /**
   * Polls an HTTP path on the container until it returns a 2xx response,
   * or the retry budget is exhausted.
   *
   * Returns the number of tries used, or throws if the path never
   * returned a healthy response.
   */
  public async waitForPath(waitOptions: WaitOptions & { path: string }): Promise<number> {
    const { portToCheck: port, path } = waitOptions;
    const tcpPort = this.container.getTcpPort(port);
    const abortedSignal = new Promise(res => {
      waitOptions.signal?.addEventListener('abort', () => {
        res(true);
      });
    });
    const pollInterval = waitOptions.waitInterval ?? INSTANCE_POLL_INTERVAL_MS;
    const tries = waitOptions.retries ?? Math.ceil(TIMEOUT_TO_GET_PORTS_MS / pollInterval);
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;

    for (let i = 0; i < tries; i++) {
      try {
        const combinedSignal = addTimeoutSignal(waitOptions.signal, PING_TIMEOUT_MS);
        const response = await tcpPort.fetch(`http://container${normalizedPath}`, {
          signal: combinedSignal,
        });

        // Free response body regardless of status
        try {
          await response.body?.cancel();
        } catch {}

        if (response.ok) {
          console.log(`Path ${normalizedPath} on port ${port} is healthy`);
          return i;
        }

        throw new Error(
          `path ${normalizedPath} on port ${port} returned status ${response.status}`
        );
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);

        console.debug(`Error checking ${normalizedPath} on ${port}: ${errorMessage}`);

        if (!this.container.running) {
          try {
            await this.onError(
              new Error(
                `Container crashed while checking ${normalizedPath} on port ${port}, did you start the container and setup the entrypoint correctly?`
              )
            );
          } catch {}

          throw e;
        }

        if (i === tries - 1) {
          try {
            await this.onError(
              `Failed to verify ${normalizedPath} on port ${port} is healthy after ${(i + 1) * pollInterval}ms, last error: ${errorMessage}`
            );
          } catch {}
          throw e;
        }

        await Promise.any([
          new Promise(resolve => setTimeout(resolve, pollInterval)),
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
    console.log('Activity expired, signalling container to stop');
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

  /**
   * Decrement the inflight request counter.
   * When the counter transitions to 0, renew the activity timeout so the
   * inactivity window starts fresh from the moment the last request completes.
   */
  private decrementInflight() {
    this.inflightRequests = Math.max(0, this.inflightRequests - 1);
    if (this.inflightRequests === 0) {
      this.renewActivityTimeout();
    }
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

    this.inflightRequests++;

    try {
      // Renew the activity timeout whenever a request is proxied
      this.renewActivityTimeout();
      const res = await tcpPort.fetch(containerUrl, request);

      if (res.webSocket !== null) {
        // WebSocket response: proxy by accepting both sides and forwarding messages
        const containerWs = res.webSocket;
        const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];

        // Guard to ensure we only decrement inflight once per WebSocket,
        // since both close and error events can fire.
        let settled = false;
        const settleInflight = () => {
          if (!settled) {
            settled = true;
            this.decrementInflight();
          }
        };

        // Accept both WebSocket ends
        containerWs.accept();
        server.accept();

        // Forward messages from client to container
        server.addEventListener('message', async (event: MessageEvent) => {
          this.renewActivityTimeout();
          try {
            const data = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
            containerWs.send(data);
          } catch {
            server.close(1011, 'Failed to forward message to container');
          }
        });

        // Forward messages from container to client
        containerWs.addEventListener('message', async (event: MessageEvent) => {
          this.renewActivityTimeout();
          try {
            const data = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
            server.send(data);
          } catch {
            containerWs.close(1011, 'Failed to forward message to client');
          }
        });

        // Forward close from client to container
        server.addEventListener('close', (event: CloseEvent) => {
          settleInflight();
          // Codes 1005 (No Status Received) and 1006 (Abnormal Closure) are
          // reserved and cannot be sent in a close frame — fall back to 1000.
          const code = event.code === 1005 || event.code === 1006 ? 1000 : event.code;
          containerWs.close(code, event.reason);
        });

        // Forward close from container to client
        containerWs.addEventListener('close', (event: CloseEvent) => {
          settleInflight();
          const code = event.code === 1005 || event.code === 1006 ? 1000 : event.code;
          server.close(code, event.reason);
        });

        // Forward errors
        server.addEventListener('error', () => {
          settleInflight();
          containerWs.close(1011, 'Client WebSocket error');
        });

        containerWs.addEventListener('error', () => {
          settleInflight();
          server.close(1011, 'Container WebSocket error');
        });

        return new Response(null, { status: 101, webSocket: client });
      }

      if (res.body !== null) {
        let { readable, writable } = new TransformStream();
        res.body?.pipeTo(writable).finally(() => {
          this.decrementInflight();
        });

        return new Response(readable, res);
      }

      this.decrementInflight();
      return res;
    } catch (e) {
      this.decrementInflight();

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
  private inflightRequests = 0;

  // Outbound interception runtime overrides (passed through ContainerProxy props)
  private outboundByHostOverrides: OutboundByHostOverrides = {};
  private outboundHandlerOverride?: OutboundHandlerOverride;

  // Set to true once `setReadinessChecks` has been called. Signals that
  // the user wants full control — auto `portResponding` checks for
  // `defaultPort` / `requiredPorts` are no longer added on top.
  private readinessChecksReplaced = false;

  // ==========================
  //     GENERAL HELPERS
  // ==========================

  /**
   * Validates that a method name exists in the outboundHandlers registry for this class.
   * @throws Error if the method name is not found
   */
  private validateOutboundHandlerMethodName(methodName: string): void {
    const handlers = outboundHandlersRegistry.get(this.constructor.name);
    if (!handlers || !(methodName in handlers)) {
      throw new Error(
        `Outbound handler method '${methodName}' not found in outboundHandlers for ${this.constructor.name}`
      );
    }
  }

  private getOutboundConfiguration(): PersistedOutboundConfiguration {
    return {
      enableInternet: this.enableInternet,
      outboundByHostOverrides:
        Object.keys(this.outboundByHostOverrides).length > 0
          ? this.outboundByHostOverrides
          : undefined,
      outboundHandlerOverride: this.outboundHandlerOverride,
    };
  }

  private persistOutboundConfiguration(configuration: PersistedOutboundConfiguration): void {
    this.ctx.storage.kv.put(OUTBOUND_CONFIGURATION_KEY, configuration);
  }

  private restoreOutboundConfiguration(): PersistedOutboundConfiguration | undefined {
    const configuration = this.ctx.storage.kv.get<PersistedOutboundConfiguration>(
      OUTBOUND_CONFIGURATION_KEY
    );

    if (!configuration) {
      return undefined;
    }

    if (configuration.enableInternet !== undefined) {
      this.enableInternet = configuration.enableInternet;
    }

    this.outboundHandlerOverride = undefined;
    if (configuration.outboundHandlerOverride !== undefined) {
      try {
        this.validateOutboundHandlerMethodName(configuration.outboundHandlerOverride.method);
        this.outboundHandlerOverride = configuration.outboundHandlerOverride;
      } catch (error) {
        console.warn('Ignoring invalid persisted outbound handler override:', error);
      }
    }

    this.outboundByHostOverrides = {};
    for (const [hostname, override] of Object.entries(
      configuration.outboundByHostOverrides ?? {}
    )) {
      try {
        this.validateOutboundHandlerMethodName(override.method);
        this.outboundByHostOverrides[hostname] = override;
      } catch (error) {
        console.warn(`Ignoring invalid persisted outbound override for ${hostname}:`, error);
      }
    }

    return this.getOutboundConfiguration();
  }

  private async refreshOutboundInterception(): Promise<void> {
    if (!this.usingInterception) {
      return;
    }

    this.applyOutboundInterceptionPromise = this.applyOutboundInterception();
    await this.applyOutboundInterceptionPromise;
  }

  /**
   * Applies (or re-applies) outbound HTTP interception with the current
   * default registries + runtime overrides passed through ContainerProxy props.
   */
  private async applyOutboundInterception(): Promise<void> {
    const ctx = this.ctx as unknown as {
      exports?: { ContainerProxy?: (params: { props: {} }) => Fetcher };
    };
    if (ctx.exports === undefined) {
      throw new Error(
        'ctx.exports is undefined, please try to update your compatibility date or export ContainerProxy from the containers package in your worker entrypoint'
      );
    }

    if (ctx.exports.ContainerProxy === undefined) {
      throw new Error(
        'ctx.exports.ContainerProxy is undefined, export ContainerProxy from the containers package in your worker entrypoint'
      );
    }

    const outboundConfiguration = this.getOutboundConfiguration();
    this.persistOutboundConfiguration(outboundConfiguration);

    await this.container.interceptAllOutboundHttp(
      ctx.exports.ContainerProxy({
        props: {
          enableInternet: outboundConfiguration.enableInternet,
          containerId: this.ctx.id.toString(),
          className: this.constructor.name,
          outboundByHostOverrides: outboundConfiguration.outboundByHostOverrides,
          outboundHandlerOverride: outboundConfiguration.outboundHandlerOverride,
        },
      })
    );
  }

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
   * Returns a port to use for the initial "is the container reachable"
   * probe in `startContainerIfNotRunning`. This is distinct from the
   * readiness check list — it only confirms the container process is
   * listening somewhere so we can set `state = running`. Readiness checks
   * run after this probe succeeds.
   */
  private async getProbePort(overridePorts?: number | number[]): Promise<number> {
    if (overridePorts !== undefined) {
      return Array.isArray(overridePorts) ? overridePorts[0] : overridePorts;
    }

    if (this.requiredPorts && this.requiredPorts.length > 0) {
      return this.requiredPorts[0];
    }

    return this.defaultPort ?? FALLBACK_PORT_TO_CHECK;
  }

  /**
   * Build the `portResponding` checks implied by `defaultPort` /
   * `requiredPorts`. These are automatically merged into the effective
   * readiness list unless the user has explicitly called
   * `setReadinessChecks`.
   *
   * `requiredPorts` takes precedence over `defaultPort` to match the
   * existing probe semantics.
   */
  private getAutoPortChecks(): ReadinessCheck[] {
    if (this.requiredPorts && this.requiredPorts.length > 0) {
      return this.requiredPorts.map(port => portResponding(port));
    }
    if (this.defaultPort !== undefined) {
      return [portResponding(this.defaultPort)];
    }
    return [];
  }

  /**
   * Resolve the active readiness check list.
   *
   * - If `setReadinessChecks` has been called, the user's list is
   *   returned as-is (full override, no auto port checks).
   * - Otherwise, the effective list is `[...autoPortChecks, ...readyOn]`
   *   so port checks from `defaultPort` / `requiredPorts` are always
   *   included alongside user-declared checks.
   */
  private getReadinessChecks(): ReadinessCheck[] {
    if (this.readinessChecksReplaced) {
      return this.readyOn ?? [];
    }
    return [...this.getAutoPortChecks(), ...(this.readyOn ?? [])];
  }

  /**
   * Run every readiness check in parallel and resolve when they all
   * succeed. Rejects on the first failure (or timeout).
   */
  private async runReadinessChecks(
    checks: ReadinessCheck[],
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<void> {
    if (checks.length === 0) {
      return;
    }

    const signal =
      options.timeoutMs !== undefined
        ? addTimeoutSignal(options.signal, options.timeoutMs)
        : options.signal;

    await Promise.all(checks.map(check => check(this, { signal })));
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
      // TODO: hopefully, enableInternet can be false in a future where we enable DNS
      // and TLS paths.

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
        await this.refreshOutboundInterception();
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
    if (this.inflightRequests > 0) {
      this.renewActivityTimeout();
      return false;
    }

    return this.sleepAfterMs <= Date.now();
  }
}
