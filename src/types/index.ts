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

export interface CancellationOptions {
  abort?: AbortSignal;
  instanceGetTimeoutMS?: number;
  portReadyTimeoutMS?: number;
  waitInterval?: number;
}

export interface WaitOptions {
  abort?: AbortSignal;
  retries: number;
  waitInterval: number;
  portToCheck: number;
}

/**
 * Represents a scheduled task within a Container
 * @template T Type of the payload data
 */
export type Schedule<T = string> = {
  /** Unique identifier for the schedule */
  taskId: string;
  /** Name of the method to be called */
  callback: string;
  /** Data to be passed to the callback */
  payload: T;
} & (
  | {
      /** Type of schedule for one-time execution at a specific time */
      type: 'scheduled';
      /** Timestamp when the task should execute */
      time: number;
    }
  | {
      /** Type of schedule for delayed execution */
      type: 'delayed';
      /** Timestamp when the task should execute */
      time: number;
      /** Number of seconds to delay execution */
      delayInSeconds: number;
    }
);

/**
 * Params sent to `onStop` method when the container stops
 */
export type StopParams = {
  exitCode: number;
  reason: 'exit' | 'runtime_signal';
};

export type ScheduleSQL = {
  id: string;
  callback: string;
  payload: string;
  type: 'scheduled' | 'delayed';
  time: number;
  delayInSeconds?: number;
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

/**
 * Options for creating a checkpoint
 */
export interface CheckpointOptions {
  /** Optional custom name for the checkpoint */
  name?: string;
  /** Specific path to checkpoint (defaults to entire container filesystem) */
  path?: string;
  /** Custom timeout for checkpoint operation in seconds */
  timeoutSeconds?: number;
}

/**
 * Result of a checkpoint operation
 */
export interface CheckpointResult {
  /** Auto-generated checkpoint ID */
  checkpointId: string;
  /** Full R2 path where checkpoint is stored */
  r2Path: string;
  /** Timestamp when checkpoint was created */
  createdAt: Date;
  /** Size of checkpoint in bytes */
  sizeBytes: number;
  /** Path that was checkpointed */
  checkpointedPath: string;
}

/**
 * Options for restoring from a checkpoint
 */
export interface RestoreOptions {
  /** Checkpoint ID to restore from */
  checkpointId: string;
  /** Custom timeout for restore operation in seconds */
  timeoutSeconds?: number;
  /** Whether to start container after restore (default: true) */
  startAfterRestore?: boolean;
}

/**
 * Result of a restore operation
 */
export interface RestoreResult {
  /** Checkpoint ID that was restored */
  checkpointId: string;
  /** Path where data was restored */
  restoredPath: string;
  /** Timestamp when restore completed */
  restoredAt: Date;
  /** Size of data restored in bytes */
  restoredSizeBytes: number;
}

/**
 * Information about a stored checkpoint
 */
export interface CheckpointInfo {
  /** Checkpoint ID */
  checkpointId: string;
  /** R2 path */
  r2Path: string;
  /** Creation timestamp */
  createdAt: Date;
  /** Expiration timestamp (2 weeks from creation) */
  expiresAt: Date;
  /** Size in bytes */
  sizeBytes: number;
  /** Original path that was checkpointed */
  originalPath: string;
}
