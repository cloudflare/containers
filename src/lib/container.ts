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
      this.monitor ??= this.setupMonitorCallbacks();
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
  public async start(
    options: {
      /** Environment variables to pass to the container */
      envVars?: Record<string, string>;
      /** Custom entrypoint to override container default */
      entrypoint?: string[];
      signal?: AbortSignal;
      /**
       * Whether to enable internet access for the container
       * @default true
       */
      enableInternet?: boolean;
      /**
       * Whether to wait for the application inside the container to be ready
       * @default true
       */
      waitForReady?: boolean;
      /**
       * Number of retries to check we have got a container
       * and if waitForReady is true, that it's ready
       * @default 10
       */
      retries?: number;
      /**
       * Timeout in milliseconds for each ping attempt
       * @default 5000
       */
      pingTimeoutMs?: number;
      /** Port to check for readiness, defaults to `defaultPort` or 33 if not set */
      portToCheck?: number;
    } = {}
  ): Promise<void> {
    // Set defaults for optional properties
    options.waitForReady ??= true;
    options.retries ??= 10;
    options.pingTimeoutMs ??= PING_TIMEOUT_MS;
    options.enableInternet ??= true;

    if (this.container.running && options.waitForReady === false) {
      // should we still ping?
      return;
    }

    // we will race the ping interval timeout against this
    const userSignalPromise = new Promise<void>(res => {
      options.signal?.addEventListener('abort', () => {
        res();
      });
    });

    const portToCheck = options.portToCheck ?? this.defaultPort ?? FALLBACK_PORT_TO_CHECK;

    let attempt = 0;
    let lastError: Error | undefined = undefined; // only if cloudchamberd gives us a no instance error
    const initiallyRunning = this.container.running; // checks if we need to trigger onStart
    let startupMonitor: Promise<void> | undefined; // we need different callbacks for this particular monitor.

    while (attempt < options.retries) {
      if (options.signal?.aborted) {
        throw new Error('Container start aborted by user signal');
      }
      if (!this.container.running && (attempt === 0 || isNoInstanceError(lastError))) {
        const resolvedEnvVars = options.envVars ?? this.envVars;
        const resolvedEntrypoint = options.entrypoint ?? this.entrypoint;
        this.container.start({
          ...(resolvedEnvVars && { env: resolvedEnvVars }),
          ...(resolvedEntrypoint && { entrypoint: resolvedEntrypoint }),
          enableInternet: options.enableInternet ?? this.enableInternet, // defaults to true
        });
        lastError = undefined;
      }
      // TODO: confirm you can register multiple monitor promises
      startupMonitor ??= this.container.monitor();

      const combinedSignal = addTimeoutSignal(options.signal, options.pingTimeoutMs);
      try {
        // in the future this could be a user defined healthcheck
        await this.container
          .getTcpPort(portToCheck)
          .fetch('http://ping', { signal: combinedSignal });
        break;
      } catch (e) {
        if (this.container.running) {
          if (!options.waitForReady && !isNotListeningError(e)) {
            break;
          }
        } else {
          await startupMonitor.catch(async err => {
            // this is the only case where we want to retry,
            // as a new instance might become available
            if (isNoInstanceError(err) && attempt < options.retries!) {
              lastError = err;
            } else {
              await this.ctx.blockConcurrencyWhile(async () => {
                await this.onError(err);
              });
              // assume the container crashed and give up
              throw err;
            }
          });
          startupMonitor = undefined;
        }

        console.debug('The container was not ready:', e instanceof Error ? e.message : String(e));

        if (attempt === options.retries) {
          if (e instanceof Error && e.message.includes('Network connection lost')) {
            // We have to abort here, the reasoning is that we might've found
            // ourselves in an internal error where the Worker is stuck with a failed connection to the
            // container services.
            //
            // Until we address this issue on the back-end CF side, we will need to abort the
            // durable object so it retries to reconnect from scratch.
            this.ctx.abort();
          }
          // we are out of retries. if we are here the container must have started because otherwise we would have thrown earlier
          throw new Error('The container application did not become ready in time.');
        }
      }

      // wait a bit before retrying
      await Promise.race([
        new Promise(res => setTimeout(res, INSTANCE_POLL_INTERVAL_MS)),
        userSignalPromise,
      ]);
      attempt++;
    }

    if (initiallyRunning === false) {
      await this.ctx.blockConcurrencyWhile(async () => {
        await this.onStart();
      });
    }
    this.monitor ??= this.setupMonitorCallbacks();
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

  // ===========================================
  //     CONTAINER INTERACTION & MONITORING
  // ===========================================

  // TODO: we may need to update this to work with setinactivityTimeout
  /** use this rather than calling monitor directly. */
  private async setupMonitorCallbacks() {
    return this.container
      .monitor()
      .then(async () => {
        await this.ctx.blockConcurrencyWhile(async () => {
          await this.onStop({ exitCode: 0, reason: 'exit' });
        });
      })
      .catch(async (error: unknown) => {
        await this.ctx.blockConcurrencyWhile(async () => {
          await this.onError(error);
        });
        if (isNoInstanceError(error)) {
          // we will inform later (TODO: why?? when??)
          return;
        }
      })
      .finally(() => {
        this.monitor = undefined;
      });
  }
}
