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
