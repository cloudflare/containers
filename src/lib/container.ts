import type { ContainerOptions, ContainerStartOptions, StopParams, State } from '../types';
import { parseTimeExpression } from './helpers';
import { DurableObject } from 'cloudflare:workers';

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

const PING_TIMEOUT_MS = 5000;

const DEFAULT_SLEEP_AFTER = '10m'; // Default sleep after inactivity time
const INSTANCE_POLL_INTERVAL_MS = 300; // Default interval for polling container state

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

  existingSignal?.addEventListener('abort', () => controller.abort());

  // Add timeout
  const timeoutId = setTimeout(() => controller.abort('ping timed out'), timeoutMs);

  // Clean up timeout if signal is aborted early
  controller.signal.addEventListener('abort', () => clearTimeout(timeoutId));

  // note the timeout aborting does not clear the existing signal
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
      await this.ctx.container?.setInactivityTimeout(parseTimeExpression(this.sleepAfter) * 1000);
    });

    this.container = ctx.container;

    // Apply options if provided
    if (options) {
      if (options.defaultPort !== undefined) this.defaultPort = options.defaultPort;
      if (options.sleepAfter !== undefined) this.sleepAfter = options.sleepAfter;
    }

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

  /**
   *
   * Starts container.
   * If the container is already started, and waitForReady is false, this will resolve immediately if the container accepts the ping.
   *
   */
  public async start(options: {
    /** Environment variables to pass to the container */
    envVars?: Record<string, string>;
    /** Custom entrypoint to override container default */
    entrypoint?: string[];
    /** Whether to enable internet access for the container */
    enableInternet?: boolean;
    signal?: AbortSignal;
    // whether to wait for the application inside the container to be ready
    waitForReady?: boolean;
    retryOptions?: {
      retries?: number;
      intervalMs?: number;
      pingTimeoutMs?: number;
    };
    portToCheck?: number;
  }): Promise<void> {
    options.waitForReady ??= true;
    if (this.container.running && options.waitForReady === false) {
      return;
    }

    options.retryOptions ??= {};
    options.retryOptions.retries ??= 6;
    options.retryOptions.intervalMs ??= INSTANCE_POLL_INTERVAL_MS;
    options.retryOptions.pingTimeoutMs ??= PING_TIMEOUT_MS;

    // race timeout against this
    const userAbortSignal = new Promise<void>(res => {
      options.signal?.addEventListener('abort', () => {
        res();
      });
    });

    const portToCheck = options.portToCheck ?? this.defaultPort ?? FALLBACK_PORT_TO_CHECK;

    let attempt = 0;
    let retryStart = false;
    let initiallyRunning = this.container.running;
    while (attempt < options.retryOptions.retries) {
      if (options.signal?.aborted) {
        throw new Error('Container start aborted');
      }
      if (!this.container.running && (attempt === 0 || retryStart)) {
        const resolvedEnvVars = options.envVars ?? this.envVars;
        const resolvedEntrypoint = options.entrypoint ?? this.entrypoint;
        this.container.start({
          ...(resolvedEnvVars && { env: resolvedEnvVars }),
          ...(resolvedEntrypoint && { entrypoint: resolvedEntrypoint }),
          enableInternet: options.enableInternet ?? this.enableInternet, // defaults to true
        });
        retryStart = false;
        if (!this.monitor) {
          this.monitor = this.container.monitor();
        }
      }

      const combinedSignal = addTimeoutSignal(options.signal, options.retryOptions.pingTimeoutMs);
      try {
        // in the future this could be a user defined healthcheck
        await this.container
          .getTcpPort(portToCheck)
          .fetch('http://ping', { signal: combinedSignal });
        if (initiallyRunning === false) {
          await this.onStart();
        }
        return;
      } catch (e) {
        if (this.container.running) {
          if (!options.waitForReady && !isNotListeningError(e)) {
            return;
          }
        } else {
          await this.monitor?.catch(err => {
            // this is the only case where we want to retry,
            // as a new instance might become available
            if (isNoInstanceError(err)) {
              retryStart = true;
            } else {
              // assume the container crashed and give up
              throw err;
            }
          });
        }

        console.debug('Container was not ready:', e instanceof Error ? e.message : String(e));
        attempt++;
        if (attempt >= options.retryOptions.retries) {
          if (e instanceof Error && e.message.includes('Network connection lost')) {
            // We have to abort here, the reasoning is that we might've found
            // ourselves in an internal error where the Worker is stuck with a failed connection to the
            // container services.
            //
            // Until we address this issue on the back-end CF side, we will need to abort the
            // durable object so it retries to reconnect from scratch.
            this.ctx.abort();
          }
          // we are out of retries
          throw new Error(NO_CONTAINER_INSTANCE_ERROR);
        }
      }
      await Promise.race([
        new Promise(res => setTimeout(res, options.retryOptions?.intervalMs)),
        userAbortSignal,
      ]);
    }
  }

  // =======================
  //     LIFECYCLE HOOKS
  // =======================

  /**
   * Send a signal to the container.
   * @param signal - The signal to send to the container (default: 15 for SIGTERM)
   */
  public async stop(signal: Signal | SignalInteger = 'SIGTERM'): Promise<void> {
    this.container.signal(typeof signal === 'string' ? signalToNumbers[signal] : signal);
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

  // TODO: update onStop to work with setInactivityTimeout
  /**
   * Lifecycle method called when container shuts down
   * Override this method in subclasses to handle Container stopped events
   * @param params - Object containing exitCode and reason for the stop
   */
  public onStop(_: StopParams): void | Promise<void> {
    // Default implementation does nothing
  }

  // TODO: update onError to work with setInactivityTimeout
  // (currently the DO can die while the container is running
  //  which will drop the monitor promise )
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

  // ============
  //     HTTP
  // ============

  override async fetch(request: Request): Promise<Response> {
    const portFromUrl = new URL(request.url).port;
    const targetPort = this.defaultPort ?? (portFromUrl ? parseInt(portFromUrl) : undefined);
    if (targetPort === undefined) {
      throw new Error(
        // TODO: update this with a docs url.
        'No port configured for this container. Set the `defaultPort` in your Container subclass, or specify a port on your request url`.'
      );
    }

    await this.start({ portToCheck: targetPort, waitForReady: true, signal: request.signal });

    const tcpPort = this.container.getTcpPort(targetPort);

    return await tcpPort.fetch(request.url.replace('https:', 'http:'), request);
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

  // ===========================================
  //     CONTAINER INTERACTION & MONITORING
  // ===========================================

  /**
   * Tries to start a container if it's not already running
   * Returns the number of tries used
   */

  // TODO: we may need to update this to work with setinactivityTimeout
  private setupMonitorCallbacks() {
    if (this.monitorSetup) {
      return;
    }

    this.monitorSetup = true;
    this.monitor
      ?.then(async () => {
        await this.ctx.blockConcurrencyWhile(async () => {
          await this.onStop({ exitCode: 0, reason: 'exit' });
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
      });
  }
}
