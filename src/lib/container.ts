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
  CheckpointOptions,
  CheckpointResult,
  RestoreOptions,
  RestoreResult,
  CheckpointInfo,
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
const TIMEOUT_TO_GET_CONTAINER_SECONDS = 8;

// Timeout for getting a container instance and launching
// the actual application and have it listen for specific ports
// One day might be configurable by the end user in Container class attribute
const TIMEOUT_TO_GET_PORTS = 20;

// Number of tries based on polling interval
const TRIES_TO_GET_CONTAINER = Math.ceil(
  (TIMEOUT_TO_GET_CONTAINER_SECONDS * 1000) / INSTANCE_POLL_INTERVAL_MS
);
const TRIES_TO_GET_PORTS = Math.ceil((TIMEOUT_TO_GET_PORTS * 1000) / INSTANCE_POLL_INTERVAL_MS);

// If user has specified no ports and we need to check one
// to see if the container is up at all.
const FALLBACK_PORT_TO_CHECK = 33;

// Since the timing isn't working, hard coding a max attempts seems
// to be the only viable solution for now
const TEMPORARY_HARDCODED_ATTEMPT_MAX = 6;

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

    // Create checkpoints table if it doesn't exist
    this.sql`
      CREATE TABLE IF NOT EXISTS container_checkpoints (
        checkpoint_id TEXT PRIMARY KEY NOT NULL,
        container_id TEXT NOT NULL,
        container_name TEXT NOT NULL,
        r2_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        original_path TEXT NOT NULL
      )
    `;

    // Create index for efficient queries
    this.sql`
      CREATE INDEX IF NOT EXISTS idx_container_checkpoints_container_id 
      ON container_checkpoints(container_id)
    `;
    
    this.sql`
      CREATE INDEX IF NOT EXISTS idx_container_checkpoints_created_at 
      ON container_checkpoints(created_at)
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
    const portToCheck =
      this.defaultPort ?? (this.requiredPorts ? this.requiredPorts[0] : FALLBACK_PORT_TO_CHECK);
    await this.startContainerIfNotRunning(
      {
        abort: waitOptions?.signal,
        waitInterval: INSTANCE_POLL_INTERVAL_MS,
        retries: TRIES_TO_GET_CONTAINER,
        portToCheck,
      },
      options
    );

    this.setupMonitorCallbacks();

    // TODO: We should consider an onHealthy callback
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.onStart();
    });
  }

  /**
   * Start the container and wait for ports to be available
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
   * @param cancellationOptions
   * @param startOptions Override configuration on a per instance for env vars, entrypoint command and internet access
   * @throws Error if port checks fail after maxTries attempts
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

    const state = await this.state.getState();

    // if the container is already healthy and running, assume ports are ready
    if (state.status === 'healthy' && this.container.running) {
      if (this.container.running && !this.monitor) {
        // This is needed to setup the monitoring
        // Start the container if it's not running
        this.monitor = this.container.monitor();
        this.setupMonitorCallbacks();
      }
      return;
    }

    // trigger all onStop that we didn't do yet
    await this.syncPendingStoppedEvents();

    // Prepare to start the container
    resolvedCancellationOptions ??= {};
    let containerGetRetries = resolvedCancellationOptions.instanceGetTimeoutMS
      ? Math.ceil(resolvedCancellationOptions.instanceGetTimeoutMS / INSTANCE_POLL_INTERVAL_MS)
      : TRIES_TO_GET_CONTAINER;

    const waitOptions = {
      abort: resolvedCancellationOptions.abort,
      retries: containerGetRetries,
      waitInterval: resolvedCancellationOptions.waitInterval ?? INSTANCE_POLL_INTERVAL_MS,
      portToCheck: portsToCheck[0],
    };

    const abortedSignal = new Promise(res => {
      waitOptions.abort?.addEventListener('abort', () => {
        res(true);
      });
    });

    // Start the container if it's not running
    const triesUsed = await this.startContainerIfNotRunning(waitOptions, resolvedStartOptions);

    // Check each port
    let totalPortReadyTries = resolvedCancellationOptions.portReadyTimeoutMS
      ? Math.ceil(resolvedCancellationOptions.portReadyTimeoutMS / INSTANCE_POLL_INTERVAL_MS)
      : TRIES_TO_GET_PORTS;
    const triesLeft = totalPortReadyTries - triesUsed;

    for (const port of portsToCheck) {
      const tcpPort = this.container.getTcpPort(port);
      let portReady = false;

      // Try to connect to the port multiple times
      for (let i = 0; i < triesLeft && !portReady; i++) {
        try {
          const combinedSignal = addTimeoutSignal(waitOptions.abort, PING_TIMEOUT_MS);
          await tcpPort.fetch('http://ping', { signal: combinedSignal });

          // Successfully connected to this port
          portReady = true;
          console.log(`Port ${port} is ready`);
        } catch (e) {
          // Check for specific error messages that indicate we should keep retrying
          const errorMessage = e instanceof Error ? e.message : String(e);

          console.debug(`Error checking ${port}: ${errorMessage}`);

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
          if (i === triesLeft - 1) {
            try {
              // TODO: Remove attempts, the end user doesn't care about this
              await this.onError(
                `Failed to verify port ${port} is available after ${waitOptions.retries} attempts, last error: ${errorMessage}`
              );
            } catch {}
            throw e;
          }

          // Wait a bit before trying again
          await Promise.any([
            new Promise(resolve => setTimeout(resolve, waitOptions.waitInterval)),
            abortedSignal,
          ]);

          if (waitOptions.abort?.aborted) {
            throw new Error('Container request timed out.');
          }
        }
      }
    }

    this.setupMonitorCallbacks();

    await this.ctx.blockConcurrencyWhile(async () => {
      // All ports are ready
      await this.state.setHealthy();
      await this.onStart();
    });
  }

  // =======================
  //     LIFECYCLE HOOKS
  // =======================

  /**
   * Shuts down the container.
   * @param signal - The signal to send to the container (default: 15 for SIGTERM)
   */
  public async stop(signal: Signal | SignalInteger = 'SIGTERM'): Promise<void> {
    this.container.signal(typeof signal === 'string' ? signalToNumbers[signal] : signal);
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
   * Lifecycle method called when the container is running, and the activity timeout
   * expiration has been reached.
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
  //     CHECKPOINTING
  // ==================

  /**
   * Create a checkpoint of the container's filesystem
   * 
   * This method creates a snapshot of the container's filesystem (or a specific path)
   * and stores it in R2 for later restoration. The checkpoint is automatically named
   * based on the container instance and timestamp.
   * 
   * @example
   * // Basic usage - checkpoint entire container
   * const result = await container.checkpoint();
   * console.log('Checkpoint created:', result.checkpointId);
   * 
   * @example
   * // Checkpoint specific directory
   * const result = await container.checkpoint({ path: '/app' });
   * 
   * @param options - Optional configuration for the checkpoint
   * @returns Promise<CheckpointResult> containing checkpoint details
   * @throws Error if container is not running or checkpoint fails
   */
  public async checkpoint(options?: CheckpointOptions): Promise<CheckpointResult> {
    const state = await this.getState();
    if (state.status !== 'healthy' && state.status !== 'running') {
      throw new Error('Container must be running to create a checkpoint');
    }

    // Generate checkpoint ID and R2 path
    const timestamp = new Date();
    const timestampStr = timestamp.toISOString().replace(/[:.]/g, '-').slice(0, -5); // yyyy-mm-ddThh-mm-ss
    const checkpointId = `${this.getContainerName()}-${this.ctx.id.toString()}-${timestampStr}`;
    const checkpointPath = options?.path || '/';
    const timeoutSeconds = options?.timeoutSeconds || 300; // 5 minute default
    
    const r2Path = `container-checkpoints/${this.getContainerName()}/${this.ctx.id.toString()}/container-snapshot-${timestampStr}`;

    try {
      // Execute checkpoint command in container
      const checkpointResult = await this.executeCheckpointCommand(checkpointPath, r2Path, timeoutSeconds);
      
      // Store checkpoint metadata
      await this.storeCheckpointMetadata({
        checkpointId,
        r2Path,
        createdAt: timestamp,
        sizeBytes: checkpointResult.sizeBytes,
        originalPath: checkpointPath,
      });

      this.renewActivityTimeout();

      return {
        checkpointId,
        r2Path,
        createdAt: timestamp,
        sizeBytes: checkpointResult.sizeBytes,
        checkpointedPath: checkpointPath,
      };
    } catch (error) {
      await this.onError(`Failed to create checkpoint: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Restore container from a checkpoint
   * 
   * This method restores the container's filesystem from a previously created checkpoint.
   * The container will be stopped, data restored to the original paths, and optionally restarted.
   * 
   * @example
   * // Basic restore
   * const result = await container.restore({ checkpointId: 'my-container-123-2023-12-01T10-30-00' });
   * 
   * @example
   * // Restore without auto-starting
   * const result = await container.restore({
   *   checkpointId: 'my-container-123-2023-12-01T10-30-00',
   *   startAfterRestore: false
   * });
   * 
   * @param options - Configuration for the restore operation
   * @returns Promise<RestoreResult> containing restore details
   * @throws Error if checkpoint doesn't exist or restore fails
   */
  public async restore(options: RestoreOptions): Promise<RestoreResult> {
    const timeoutSeconds = options.timeoutSeconds || 300; // 5 minute default
    const startAfterRestore = options.startAfterRestore !== false; // default true

    // Get checkpoint metadata
    const checkpointInfo = await this.getCheckpointInfo(options.checkpointId);
    if (!checkpointInfo) {
      throw new Error(`Checkpoint ${options.checkpointId} not found`);
    }

    // Check if checkpoint has expired
    if (new Date() > checkpointInfo.expiresAt) {
      throw new Error(`Checkpoint ${options.checkpointId} has expired`);
    }

    try {
      // Stop container if running
      if (this.container.running) {
        await this.stop();
        // Wait for container to stop
        await this.waitForStop();
      }

      // Start container in preparation for restore
      await this.start();
      
      // Execute restore command
      const restoreResult = await this.executeRestoreCommand(
        checkpointInfo.r2Path,
        checkpointInfo.originalPath,
        timeoutSeconds
      );

      // Restart container if requested
      if (startAfterRestore) {
        await this.stop();
        await this.waitForStop();
        await this.startAndWaitForPorts();
      }

      this.renewActivityTimeout();

      return {
        checkpointId: options.checkpointId,
        restoredPath: checkpointInfo.originalPath,
        restoredAt: new Date(),
        restoredSizeBytes: restoreResult.sizeBytes,
      };
    } catch (error) {
      await this.onError(`Failed to restore checkpoint: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * List all available checkpoints for this container
   * 
   * @returns Promise<CheckpointInfo[]> array of checkpoint information
   */
  public async listCheckpoints(): Promise<CheckpointInfo[]> {
    const result = this.sql<{
      checkpoint_id: string;
      r2_path: string;
      created_at: number;
      size_bytes: number;
      original_path: string;
    }>`
      SELECT * FROM container_checkpoints 
      WHERE container_id = ${this.ctx.id.toString()}
      ORDER BY created_at DESC
    `;

    return result
      .map(row => ({
        checkpointId: row.checkpoint_id,
        r2Path: row.r2_path,
        createdAt: new Date(row.created_at),
        expiresAt: new Date(row.created_at + (14 * 24 * 60 * 60 * 1000)), // 2 weeks
        sizeBytes: row.size_bytes,
        originalPath: row.original_path,
      }))
      .filter(checkpoint => new Date() <= checkpoint.expiresAt); // Filter out expired
  }

  /**
   * Delete a specific checkpoint
   * 
   * @param checkpointId - ID of the checkpoint to delete
   * @returns Promise<boolean> true if deleted, false if not found
   */
  public async deleteCheckpoint(checkpointId: string): Promise<boolean> {
    const checkpointInfo = await this.getCheckpointInfo(checkpointId);
    if (!checkpointInfo) {
      return false;
    }

    try {
      // Delete from R2 (via container command)
      await this.executeDeleteCheckpointCommand(checkpointInfo.r2Path);
      
      // Remove from database
      this.sql`DELETE FROM container_checkpoints WHERE checkpoint_id = ${checkpointId}`;

      return true;
    } catch (error) {
      console.error(`Failed to delete checkpoint ${checkpointId}:`, error);
      return false;
    }
  }

  /**
   * Clean up expired checkpoints
   * This method removes checkpoints older than 2 weeks
   */
  public async cleanupExpiredCheckpoints(): Promise<number> {
    const twoWeeksAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);
    
    const expiredCheckpoints = this.sql<{
      checkpoint_id: string;
      r2_path: string;
    }>`
      SELECT checkpoint_id, r2_path FROM container_checkpoints 
      WHERE container_id = ${this.ctx.id.toString()}
      AND created_at < ${twoWeeksAgo}
    `;

    let deletedCount = 0;
    for (const checkpoint of expiredCheckpoints) {
      try {
        await this.executeDeleteCheckpointCommand(checkpoint.r2_path);
        this.sql`DELETE FROM container_checkpoints WHERE checkpoint_id = ${checkpoint.checkpoint_id}`;
        deletedCount++;
      } catch (error) {
        console.error(`Failed to delete expired checkpoint ${checkpoint.checkpoint_id}:`, error);
      }
    }

    return deletedCount;
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
   * This method handles HTTP requests to the container. WebSocket requests done outside the DO*
   * won't work until https://github.com/cloudflare/workerd/issues/2319 is addressed. Until then, please use `switchPort` + `fetch()`.
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

    const tcpPort = this.container.getTcpPort(port!);

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
   * Handle fetch requests to the Container
   * Default implementation forwards all HTTP and WebSocket requests to the container
   * Override this in your subclass to specify a port or implement custom request handling
   *
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
  ): { request: Request; port: number | undefined } {
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

    port = port ?? this.defaultPort;

    return { request, port };
  }

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

  // Tries to start a container if it's not running
  // Reutns the number of tries used
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

        await this.scheduleNextAlarm();
        this.container.start(startConfig);
        this.monitor = this.container.monitor();
      } else {
        await this.scheduleNextAlarm();
      }

      this.renewActivityTimeout();

      // TODO: Make this the port I'm trying to get!
      const port = this.container.getTcpPort(waitOptions.portToCheck);
      try {
        const combinedSignal = addTimeoutSignal(waitOptions.abort, PING_TIMEOUT_MS);
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

        if (waitOptions.abort?.aborted) {
          throw new Error(
            'Aborted waiting for container to start as we received a cancellation signal'
          );
        }

        // TODO: Don't hardcode to 3, use the max attempts
        // TODO: Make this error specific to this, but then catch it above w something else
        if (TEMPORARY_HARDCODED_ATTEMPT_MAX === tries) {
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

    throw new Error(
      `Container did not start after ${waitOptions.retries * waitOptions.waitInterval}ms`
    );
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

  // ===============================
  //     CHECKPOINT HELPER METHODS
  // ===============================

  /**
   * Get the container name for checkpoint organization
   */
  private getContainerName(): string {
    // Use the DO class name as container name
    return this.constructor.name;
  }

  /**
   * Wait for container to stop completely
   */
  private async waitForStop(timeoutMs: number = 30000): Promise<void> {
    const startTime = Date.now();
    while (this.container.running && (Date.now() - startTime) < timeoutMs) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (this.container.running) {
      throw new Error('Container did not stop within timeout');
    }
  }

  /**
   * Store checkpoint metadata in the database
   */
  private async storeCheckpointMetadata(metadata: {
    checkpointId: string;
    r2Path: string;
    createdAt: Date;
    sizeBytes: number;
    originalPath: string;
  }): Promise<void> {
    this.sql`
      INSERT INTO container_checkpoints (
        checkpoint_id, container_id, container_name, r2_path, 
        created_at, size_bytes, original_path
      ) VALUES (
        ${metadata.checkpointId}, 
        ${this.ctx.id.toString()}, 
        ${this.getContainerName()}, 
        ${metadata.r2Path}, 
        ${metadata.createdAt.getTime()}, 
        ${metadata.sizeBytes}, 
        ${metadata.originalPath}
      )
    `;
  }

  /**
   * Get checkpoint information from database
   */
  private async getCheckpointInfo(checkpointId: string): Promise<CheckpointInfo | null> {
    const result = this.sql<{
      checkpoint_id: string;
      r2_path: string;
      created_at: number;
      size_bytes: number;
      original_path: string;
    }>`
      SELECT * FROM container_checkpoints 
      WHERE checkpoint_id = ${checkpointId} AND container_id = ${this.ctx.id.toString()}
      LIMIT 1
    `;

    if (result.length === 0) {
      return null;
    }

    const row = result[0];
    return {
      checkpointId: row.checkpoint_id,
      r2Path: row.r2_path,
      createdAt: new Date(row.created_at),
      expiresAt: new Date(row.created_at + (14 * 24 * 60 * 60 * 1000)), // 2 weeks
      sizeBytes: row.size_bytes,
      originalPath: row.original_path,
    };
  }

  /**
   * Execute checkpoint command in the container
   */
  private async executeCheckpointCommand(
    sourcePath: string, 
    r2Path: string, 
    timeoutSeconds: number
  ): Promise<{ sizeBytes: number }> {
    const state = await this.getState();
    if (state.status !== 'healthy' && state.status !== 'running') {
      throw new Error('Container must be running to execute checkpoint command');
    }

    try {
      // Use the /__checkpoint endpoint that containers can implement
      const response = await this.containerFetch('/__checkpoint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourcePath,
          r2Path,
          timeoutSeconds,
        }),
        signal: AbortSignal.timeout(timeoutSeconds * 1000),
      });

      if (!response.ok) {
        throw new Error(`Checkpoint failed: ${response.status} ${response.statusText}`);
      }

      const result = await response.json() as { sizeBytes: number };
      return result;
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error(`Checkpoint operation timed out after ${timeoutSeconds} seconds`);
      }
      throw error;
    }
  }

  /**
   * Execute restore command in the container
   */
  private async executeRestoreCommand(
    r2Path: string,
    targetPath: string,
    timeoutSeconds: number
  ): Promise<{ sizeBytes: number }> {
    const state = await this.getState();
    if (state.status !== 'healthy' && state.status !== 'running') {
      throw new Error('Container must be running to execute restore command');
    }

    try {
      // Use the /__restore endpoint that containers can implement
      const response = await this.containerFetch('/__restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          r2Path,
          targetPath,
          timeoutSeconds,
        }),
        signal: AbortSignal.timeout(timeoutSeconds * 1000),
      });

      if (!response.ok) {
        throw new Error(`Restore failed: ${response.status} ${response.statusText}`);
      }

      const result = await response.json() as { sizeBytes: number };
      return result;
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error(`Restore operation timed out after ${timeoutSeconds} seconds`);
      }
      throw error;
    }
  }

  /**
   * Execute delete checkpoint command in the container
   */
  private async executeDeleteCheckpointCommand(r2Path: string): Promise<void> {
    try {
      // Use the /__delete-checkpoint endpoint that containers can implement
      const response = await this.containerFetch('/__delete-checkpoint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ r2Path }),
        signal: AbortSignal.timeout(30000), // 30 second timeout
      });

      if (!response.ok) {
        throw new Error(`Delete checkpoint failed: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error('Delete checkpoint operation timed out after 30 seconds');
      }
      throw error;
    }
  }
}
