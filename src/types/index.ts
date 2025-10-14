/**
 * Basic types for the container implementation
 */
import { type DurableObject } from 'cloudflare:workers';

/**
 * ContainerStartOptions as they come from worker types
 */
export type ContainerStartOptions = NonNullable<
  Parameters<NonNullable<DurableObject['ctx']['container']>['start']>[0]
>;

/**
 * Message structure for communication with containers
 */
export interface ContainerMessage<T = unknown> {
  type: string;
  payload?: T;
}

// Container state interface removed

/**
 * Options for container configuration
 */
export interface ContainerOptions {
  /** Optional ID for the container */
  id?: string;

  /** Default port number to connect to (defaults to container.defaultPort) */
  defaultPort?: number;

  /** How long to keep the container alive without activity */
  sleepAfter?: string | number;

  /** Environment variables to pass to the container */
  envVars?: Record<string, string>;

  /** Custom entrypoint to override container default */
  entrypoint?: string[];

  /** Whether to enable internet access for the container */
  enableInternet?: boolean;
}

/**
 * Function to handle container events
 */
export type ContainerEventHandler = () => void | Promise<void>;

/**
 * Options for starting a container with specific configuration
 */
export interface ContainerStartConfigOptions {
  /** Environment variables to pass to the container */
  envVars?: Record<string, string>;
  /** Custom entrypoint to override container default */
  entrypoint?: string[];
  /** Whether to enable internet access for the container */
  enableInternet?: boolean;
}

export interface StartAndWaitForPortsOptions {
  startOptions?: ContainerStartConfigOptions;
  ports?: number | number[];
  cancellationOptions?: CancellationOptions;
}

/** cancellationOptions for startAndWaitForPorts()  */
export interface CancellationOptions {
  /** abort signal, use to abort startAndWaitForPorts manually. */
  abort?: AbortSignal;
  /** max time to get container instance and start it (application inside may not be ready), in milliseconds */
  instanceGetTimeoutMS?: number;
  /** max time to wait for application to be listening at all specified ports, in milliseconds. */
  portReadyTimeoutMS?: number;
  /** time to wait between polling, in milliseconds */
  waitInterval?: number;
}

/**
 * Options for waitForPort()
 */
export interface WaitOptions {
  /** The port number to check for readiness */
  portToCheck: number;
  /** Optional AbortSignal, use this to abort waiting for ports */
  signal?: AbortSignal;
  /** Number of attempts to wait for port to be ready */
  retries?: number;
  /** Time to wait in between polling port for readiness, in milliseconds */
  waitInterval?: number;
}

/**
 * Params sent to `onStop` method when the container stops
 */
export type StopParams = {
  exitCode: number;
  reason: 'exit' | 'runtime_signal';
};

export type State = {
  lastChange: number;
} & (
  | {
      // 'running' means that the container is trying to start and is transitioning to a healthy status.
      //           onStop might be triggered if there is an exit code, and it will transition to 'stopped'.
      status: 'running' | 'stopping' | 'stopped' | 'healthy';
    }
  | {
      status: 'stopped_with_code';
      exitCode?: number;
    }
);
