import { Server } from 'partyserver';
import { nanoid } from 'nanoid';
import type { ContainerOptions, ContainerStartOptions, Schedule } from '../types';
import { DurableObject } from 'cloudflare:workers';

/**
 * Params sent to `onStop` method when the container stops
 */
export type StopParams = {
  exitCode: number;
  reason: 'exit' | 'runtime_signal';
};

type ScheduleSQL = {
  id: string;
  callback: string;
  payload: string;
  type: 'scheduled' | 'delayed';
  time: number;
  delayInSeconds?: number;
};

export function isNoInstanceError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes(
    'there is no container instance that can be provided to this durable object'
  );
}

export function isRuntimeSignalledError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes(runtimeSignalledError);
}

export function isNotListeningError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes(notListeningError);
}

export function isContainerExitNonZeroError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes(containerExitWithError);
}

const runtimeSignalledError = 'runtime signalled the container to exit:';
const containerExitWithError = 'container exited with unexpected exit code:';
const notListeningError = 'the container is not listening';

function getExitCodeFromError(error: unknown): number | null {
  if (!(error instanceof Error)) {
    return null;
  }

  if (isRuntimeSignalledError(error)) {
    return +error.message.slice(
      error.message.indexOf(runtimeSignalledError) + runtimeSignalledError.length + 1
    );
  }

  if (isContainerExitNonZeroError(error)) {
    return +error.message.slice(
      error.message.indexOf(containerExitWithError) + containerExitWithError.length + 1
    );
  }

  return null;
}

/**
 * Main Container class that wraps PartyKit's Server with container functionality
 */
export class Container<Env = unknown> extends DurableObject {
  // Default port for the container (undefined means no default port)
  defaultPort?: number;

  // Timeout after which the container will sleep if no activity
  sleepAfter: string | number = '5m';

  // Internal tracking for sleep timeout task
  #sleepTimeoutTaskId: string | null = null;

  // Whether to require manual container start (if true, it won't start automatically)
  manualStart = false;

  /**
   * Container configuration properties
   * Set these properties directly in your container instance
   */
  envVars: ContainerStartOptions['env'] = {};
  entrypoint?: ContainerStartOptions['entrypoint'];
  enableInternet: ContainerStartOptions['enableInternet'] = true;

  /**
   * Execute SQL queries against the Container's database
   */
  sql<T = Record<string, string | number | boolean | null>>(
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

  private container: NonNullable<DurableObject['ctx']['container']>;

  constructor(ctx: DurableObject['ctx'], env: Env, options?: ContainerOptions) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      // First thing, schedule the next alarms
      await this.#scheduleNextAlarm();
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

    this.recoverActivityTimeout();

    // Start the container automatically if needed
    this.ctx.blockConcurrencyWhile(async () => {
      if (this.shouldAutoStart()) {
        // Start container and wait for any required ports
        await this.startAndWaitForPorts();
        // Activity timeout is initialized in startAndWaitForPorts
      }
    });
  }

  /**
   * Determine if container should auto-start
   */
  shouldAutoStart(): boolean {
    return !this.manualStart; // Auto-start unless manual start is enabled
  }

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
   * The method applies the container configuration from your instance properties, including:
   * - Environment variables (this.env)
   * - Custom entrypoint commands (this.entrypoint)
   * - Internet access settings (this.enableInternet)
   *
   * It also sets up monitoring to track container lifecycle events and automatically
   * calls the onStop handler when the container terminates.
   *
   * @example
   * // Basic usage in a custom Container implementation
   * async customInitialize() {
   *   // Start the container without waiting for a port
   *   await this.startContainer();
   *
   *   // Perform additional initialization steps
   *   // that don't require port access
   * }
   *
   * @returns A promise that resolves when the container start command has been issued
   * @throws Error if no container context is available or if all start attempts fail
   */
  async startContainer(): Promise<void> {
    // Start the container if it's not running
    if (this.container.running) {
      return;
    }

    for (;;) {
      // Only include properties that are defined
      const startConfig: ContainerStartOptions = {};

      if (Object.keys(this.envVars).length > 0) startConfig.env = this.envVars;
      if (this.entrypoint) startConfig.entrypoint = this.entrypoint;
      if (this.enableInternet !== undefined) startConfig.enableInternet = this.enableInternet;

      await this.#cancelSleepTimeout();
      this.container.start(startConfig);
      await this.renewActivityTimeout();

      // Track container status
      this.container
        .monitor()
        .then(() => {
          this.onStop({ exitCode: 0, reason: 'exit' });
        })
        .catch((error: unknown) => {
          if (isNoInstanceError(error)) {
            // we will inform later
            return;
          }

          const exitCode = getExitCodeFromError(error);
          if (exitCode !== null) {
            this.onStop({
              exitCode,
              reason: isRuntimeSignalledError(error) ? 'runtime_signal' : 'exit',
            });

            return;
          }

          this.onError(error);
        });

      const port = this.container.getTcpPort(33);
      let lastError;
      try {
        await port.fetch('http://containerstarthealthcheck');
        return;
      } catch (error) {
        if (isNotListeningError(error)) return;

        lastError = error;
        await new Promise(res => setTimeout(res, 500));
        continue;
      }
    }
  }

  /**
   * Required ports that should be checked for availability during container startup
   * Override this in your subclass to specify ports that must be ready
   */
  requiredPorts?: number[];

  /**
   * Start the container and wait for ports to be available
   * Based on containers-starter-go implementation
   *
   * This method builds on startContainer by adding port availability verification:
   * 1. Calls startContainer to ensure the container is running
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
  async startAndWaitForPorts(ports?: number | number[], maxTries: number = 10): Promise<void> {
    // Start the container if it's not running
    await this.startContainer();

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
      for (let i = 0; i < maxTries && !portReady; i++) {
        try {
          await tcpPort.fetch('http://ping');

          // Successfully connected to this port
          portReady = true;
          console.log(`Port ${port} is ready`);
        } catch (e) {
          // Check for specific error messages that indicate we should keep retrying
          const errorMessage = e instanceof Error ? e.message : String(e);

          console.warn(`Error checking ${port}: ${errorMessage}`);

          // If we're on the last attempt and the port is still not ready, fail
          if (i === maxTries - 1) {
            throw new Error(
              `Failed to verify port ${port} is available after ${maxTries} attempts`
            );
          }

          // Wait a bit before trying again (300ms like in containers-starter-go)
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }
    }

    // All ports are ready
    this.onStart();
  }

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
  async containerFetch(
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

    if (!this.container.running) {
      try {
        await this.startAndWaitForPorts(targetPort);
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
      await this.renewActivityTimeout();

      const res = await tcpPort.fetch(containerUrl, request);
      if (res.webSocket) {
        this.websocketCount++;
        res.webSocket.addEventListener('close', async () => {
          this.websocketCount--;
          if (this.websocketCount === 0) {
            await this.#scheduleSleepTimeout();
          }
        });
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

  // websocketCount keeps track of the number of websocket connections to the container
  private websocketCount = 0;

  /**
   * Shuts down the container.
   */
  async stopContainer(signal = 15): Promise<void> {
    this.container.signal(signal);
  }

  /**
   * Destroys the container. It will trigger onError instead of onStop.
   */
  async destroyContainer(): Promise<void> {
    await this.container.destroy();
  }

  /**
   * Lifecycle method called when container starts successfully
   * Override this method in subclasses to handle container start events
   */
  onStart(): void | Promise<void> {
    // Default implementation does nothing
  }

  /**
   * Lifecycle method called when container shuts down
   * Override this method in subclasses to handle Container stopped events
   */
  onStop(_: StopParams): void | Promise<void> {
    // Default implementation does nothing
  }

  /**
   * Error handler for container errors
   * Override this method in subclasses to handle container errors
   */
  onError(error: unknown): any {
    console.error('Container error:', error);
    throw error;
  }

  /**
   * Try-catch wrapper for async operations
   */
  async #tryCatch<T>(fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw this.onError(e);
    }
  }

  /**
   * Parse a time expression into seconds
   * @private
   * @param timeExpression Time expression (number or string like "5m", "30s", "1h")
   * @returns Number of seconds
   */
  #parseTimeExpression(timeExpression: string | number): number {
    if (typeof timeExpression === 'number') {
      // If it's already a number, assume it's in seconds
      return timeExpression;
    }

    if (typeof timeExpression === 'string') {
      // Parse time expressions like "5m", "30s", "1h"
      const match = timeExpression.match(/^(\d+)([smh])$/);
      if (!match) {
        throw new Error(`invalid time expression ${timeExpression}`);
      }

      const value = parseInt(match[1]);
      const unit = match[2];

      // Convert to seconds based on unit
      switch (unit) {
        case 's':
          return value;
        case 'm':
          return value * 60;
        case 'h':
          return value * 60 * 60;
        default:
          throw new Error(`unknown time unit ${unit}`);
      }
    }

    throw new Error(`invalid type for a time expression: ${typeof timeExpression}`);
  }

  /**
   * Schedule a Container stopped after the specified sleep timeout
   * @private
   */
  async #scheduleSleepTimeout(): Promise<void> {
    // Convert the sleepAfter value to seconds
    const timeoutInSeconds = this.#parseTimeExpression(this.sleepAfter);

    // Cancel any existing timeout
    await this.#cancelSleepTimeout();

    // Schedule the Container stopped
    const { taskId } = await this.schedule(timeoutInSeconds, 'stopDueToInactivity');
    this.#sleepTimeoutTaskId = taskId;
  }

  /**
   * Cancel the scheduled sleep timeout if one exists
   * @private
   */
  async #cancelSleepTimeout(): Promise<void> {
    if (this.#sleepTimeoutTaskId) {
      try {
        await this.unschedule(this.#sleepTimeoutTaskId);
      } catch (e) {
        // Ignore errors (task may have already completed)
      }

      this.#sleepTimeoutTaskId = null;
    }
  }

  /**
   * Schedule a task to be executed in the future
   * @template T Type of the payload data
   * @param when When to execute the task (Date object or number of seconds delay)
   * @param callback Name of the method to call
   * @param payload Data to pass to the callback
   * @returns Schedule object representing the scheduled task
   */
  async schedule<T = string>(
    when: Date | number,
    callback: string,
    payload?: T
  ): Promise<Schedule<T>> {
    const id = nanoid(9);

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

      await this.#scheduleNextAlarm();

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

      await this.#scheduleNextAlarm();

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

  /**
   * Schedule the next alarm based on upcoming tasks
   * @private
   */
  async #scheduleNextAlarm(): Promise<void> {
    const existingAlarm = await this.ctx.storage.getAlarm();
    const nextTime = 1000 + Date.now();

    // if not already set
    if (existingAlarm === null || existingAlarm > nextTime || existingAlarm < Date.now()) {
      await this.ctx.storage.setAlarm(nextTime);
      await this.ctx.storage.sync();
    }
  }

  /**
   * Cancel a scheduled task
   * @param id ID of the task to cancel
   */
  async unschedule(id: string): Promise<void> {
    // Delete the schedule from the database
    this.sql`DELETE FROM container_schedules WHERE id = ${id}`;

    // Reschedule the next alarm (if any remain)
    await this.#scheduleNextAlarm();
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

  /**
   * Get scheduled tasks matching the given criteria
   * @template T Type of the payload data
   * @param criteria Criteria to filter schedules
   * @returns Array of matching Schedule objects
   */
  getSchedules<T = string>(
    criteria: {
      id?: string;
      type?: 'scheduled' | 'delayed';
      timeRange?: { start?: Date; end?: Date };
    } = {}
  ): Schedule<T>[] {
    // Build the query dynamically based on criteria
    let query = 'SELECT * FROM container_schedules WHERE 1=1';
    const params: (string | number)[] = [];

    // Add filters for each criterion
    if (criteria.id) {
      query += ' AND id = ?';
      params.push(criteria.id);
    }

    if (criteria.type) {
      query += ' AND type = ?';
      params.push(criteria.type);
    }

    if (criteria.timeRange) {
      if (criteria.timeRange.start) {
        query += ' AND time >= ?';
        params.push(Math.floor(criteria.timeRange.start.getTime() / 1000));
      }

      if (criteria.timeRange.end) {
        query += ' AND time <= ?';
        params.push(Math.floor(criteria.timeRange.end.getTime() / 1000));
      }
    }

    // Execute the query
    const result = this.ctx.storage.sql.exec(query, ...params);

    // Transform results to Schedule objects
    return result.toArray().map(row => {
      let payload: T;
      try {
        payload = JSON.parse(row.payload as string) as T;
      } catch (e) {
        console.error(`Error parsing payload for schedule ${row.id}:`, e);
        payload = undefined as unknown as T;
      }

      if (row.type === 'delayed') {
        return {
          taskId: row.id as string,
          callback: row.callback as string,
          payload,
          type: 'delayed',
          time: row.time as number,
          delayInSeconds: row.delayInSeconds as number,
        };
      }

      return {
        taskId: row.id as string,
        callback: row.callback as string,
        payload,
        type: 'scheduled',
        time: row.time as number,
      };
    });
  }

  /**
   * Method called when an alarm fires
   * Executes any scheduled tasks that are due
   */
  override async alarm(alarmProps: { isRetry: boolean; retryCount: number }): Promise<void> {
    const maxRetries = 3;

    //
    // maxRetries before scheduling next alarm is purposely set to 3,
    // as according to DO docs at https://developers.cloudflare.com/durable-objects/api/alarms/
    // the maximum amount for alarm retries is 6.
    //
    if (alarmProps.isRetry && alarmProps.retryCount > maxRetries) {
      // just schedule next alarm so we have infinite retries
      await this.#scheduleNextAlarm();
      return;
    }

    await this.#tryCatch(async () => {
      const now = Math.floor(Date.now() / 1000);

      // Get all schedules that should be executed now
      const result = this.sql<{
        id: string;
        callback: string;
        payload: string;
        type: 'scheduled' | 'delayed';
        time: number;
      }>`
        SELECT * FROM container_schedules WHERE time <= ${now}
      `;

      // Process each due schedule
      for (const row of result) {
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

      // if not running and nothing to do, stop
      if (!this.container.running) {
        return;
      }

      // Schedule the next alarm
      await this.#scheduleNextAlarm();
    });
  }

  /**
   * Renew the container's activity timeout
   * Call this method whenever there is activity on the container
   */
  async renewActivityTimeout(): Promise<void> {
    if (this.ctx?.container?.running) {
      await this.#scheduleSleepTimeout();
    }
  }

  recoverActivityTimeout(): ScheduleSQL | null {
    const result = this
      .sql<ScheduleSQL>`SELECT * FROM container_schedules WHERE callback = 'stopDueToInactivity' LIMIT 1`;
    if (result.length === 0) {
      return null;
    }

    this.#sleepTimeoutTaskId = result[0].id;
    return result[0];
  }

  /**
   * Method called by scheduled task to stop the container due to inactivity
   */
  async stopDueToInactivity(): Promise<void> {
    if (!this.container.running) {
      // Clear the task ID since it's been executed
      this.#sleepTimeoutTaskId = null;
      return;
    }

    if (this.websocketCount > 0) {
      return;
    }

    // Clear the task ID since it's been executed
    this.#sleepTimeoutTaskId = null;

    // Stop the container if it's still running
    await this.stopContainer();
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
}
