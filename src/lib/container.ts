import type { ContainerOptions, ContainerStartOptions, StopParams, State } from '../types';
import { parseTimeExpression } from './helpers';
import { DurableObject } from 'cloudflare:workers';

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

const NO_CONTAINER_INSTANCE_ERROR =
  'there is no container instance that can be provided to this durable object';

/** we can retry start */
const isNoInstanceError = (error: unknown): boolean =>
  isErrorOfType(error, NO_CONTAINER_INSTANCE_ERROR);

const NOT_LISTENING_ERROR = 'the container is not listening';
const isNotListeningError = (error: unknown): boolean => isErrorOfType(error, NOT_LISTENING_ERROR);

/**
 * Combines the existing user-defined signal with a signal that aborts after the timeout specified by waitInterval.
 * If there is no userProvidedSignal, this is just a timeout
 */
function addTimeoutSignals(
  userProvidedSignal: AbortSignal | undefined,
  timeoutMs: number
): AbortSignal {
  const controller = new AbortController();

  // Add timeout in case our pings hang
  const timeoutId = setTimeout(() => controller.abort('ping timed out'), timeoutMs);

  // If the user signal aborts, we want to cancel the timeout and clean up
  userProvidedSignal?.addEventListener('abort', () => {
    controller.abort();
    clearTimeout(timeoutId);
  });

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

    // we are not setting up a global monitor because we cannot guarantee the DO will be alive when the container stops
    // if (this.container.running) {
    //   this.monitor ??= this.setupMonitorCallbacks();
    // }
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
   * Returns a promise that resolves when the container is ready.
   * By default readiness is defined as being able to successfully fetch 'http://ping' on the specified port.
   *
   * This can be overriden by the user and will be called when starting the container
   *
   * If called by us, this will receive a port to check, which might be the target port of a fetch if this was called during fetch.
   * The user could choose to ignore this port, or check other ports as well.
   * It will also receive an abort signal which is a combination of a user provided signal and a timeout signal.
   *
   * If called by the user it won't receive these parameters :/
   *
   */
  public async readinessCheck(portToCheck?: number, signal?: AbortSignal): Promise<void> {
    await this.container
      .getTcpPort(portToCheck ?? FALLBACK_PORT_TO_CHECK)
      .fetch('http://ping', { signal });
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

    // we use a timeout so there is a bit of a cooldown between retries
    // but we still want to abort immediately if the user has requested it,
    // so we create this promise that we can race against our timeout.
    const userSignalPromise = new Promise<void>(res => {
      options.signal?.addEventListener('abort', () => {
        res();
      });
    });

    // if start was called via fetch, we will have a port passed in
    // a user can also specify a port when calling start
    // otherwise we fall back to the defaultPort property set on this instance and then a hardcoded fallback
    const portToCheck = options.portToCheck ?? this.defaultPort ?? FALLBACK_PORT_TO_CHECK;

    // we need to know if the last attempt to start resulted in a instance error.
    // this is the only time we should try to restart the container.
    // if the container has been started once and isn't running with any other error, we should throw
    let lastError: Error | undefined = undefined;
    let attempt = 0;
    const initiallyRunning = this.container.running; // so we don't call onStart if it was already running
    let startupMonitor: Promise<void> | undefined;

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
      startupMonitor ??= this.container.monitor();

      // combine the user provided AbortSignal with a timeout

      try {
        // by default this pings the container
        const timeoutSignal = addTimeoutSignals(options.signal, options.pingTimeoutMs);
        await this.readinessCheck(portToCheck, timeoutSignal);
        break;
      } catch (e) {
        if (this.container.running) {
          // return if the user has specified that we don't need to wait for the container application to be ready
          if (isNotListeningError(e) && !options.waitForReady) {
            break;
          }
          // otherwise fallthrough to retry the ping...
        } else {
          // we tried to start the container but it is now not running
          await startupMonitor.catch(async err => {
            // if the error is cloudchamberd not providing a container in time, we can retry
            if (isNoInstanceError(err)) {
              lastError = err;
            } else {
              // for any other reason, we should assume the container crashed and give up
              throw err;
            }
          });
          startupMonitor = undefined;
        }

        console.debug('The container was not ready:', e instanceof Error ? e.message : String(e));

        // we are out of retries
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
          throw e;
        }
      }

      // wait a bit before retrying
      await Promise.race([
        new Promise(res => setTimeout(res, INSTANCE_POLL_INTERVAL_MS)),
        userSignalPromise,
      ]);
      attempt++;
    }

    // we have successfully exited the start loop
    if (initiallyRunning === false) {
      await this.ctx.blockConcurrencyWhile(async () => {
        await this.onStart();
      });
    }

    // we are not setting up a global monitor because we cannot guarantee the DO will be alive when the container stops
    // this.monitor ??= this.setupMonitorCallbacks();
  }

  // =======================
  //     LIFECYCLE HOOKS
  // =======================

  /**
   * Send a signal to the container.
   * @param signal - The signal to send to the container (default: 15 for SIGTERM)
   */
  public async stop(signal: Signal | SignalInteger = 'SIGTERM'): Promise<void> {
    if (!this.container.running) {
      return;
    }
    this.container.signal(typeof signal === 'string' ? signalToNumbers[signal] : signal);
  }

  /**
   * Destroys the container with a SIGKILL.
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

  // We are not implementing onStop for now because there is no guarantee the DO will be alive when the container stops
  // and we don't have a way for cloudchamberd to wake up the DO
  // /**
  //  * Lifecycle method called when container shuts down
  //  * Override this method in subclasses to handle Container stopped events
  //  * @param params - Object containing exitCode and reason for the stop
  //  */
  // public onStop(_: StopParams): void | Promise<void> {
  //   // Default implementation does nothing
  // }

  // We are not implementing onStop for now because there is no guarantee the DO will be alive when the container stops
  // and we don't have a way for cloudchamberd to wake up the DO
  /**
   * Error handler for container errors
   * Override this method in subclasses to handle container errors
   * @param error - The error that occurred
   * @returns Can return any value or throw the error
   */
  // public onError(error: unknown): any {
  //   console.error('Container error:', error);
  //   throw error;
  // }

  // ============
  //     HTTP
  // ============

  // this should not be overridden by the user
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

  public container: NonNullable<DurableObject['ctx']['container']>;
  private state: ContainerState;

  // we are not setting up a global monitor because we cannot guarantee the DO will be alive when the container stops
  // private monitor: Promise<unknown> | undefined;

  // we are not setting up a global monitor because we cannot guarantee the DO will be alive when the container stops
  // private async setupMonitorCallbacks() {
  //   return (
  //     this.container
  //       .monitor()
  //       .then(async () => {
  //         await this.ctx.blockConcurrencyWhile(async () => {
  //           await this.onStop({ exitCode: 0, reason: 'exit' });
  //         });
  //       })
  //       .catch(async (error: unknown) => {
  //         await this.ctx.blockConcurrencyWhile(async () => {
  //           await this.onError(error);
  //         });
  //         if (isNoInstanceError(error)) {
  //           // we will inform later (TODO: why?? when??)
  //           return;
  //         }
  //       })
  //       //
  //       .finally(() => {
  //         this.monitor = undefined;
  //       })
  //   );
  // }
}
