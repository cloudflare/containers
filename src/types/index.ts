/**
 * Basic types for the container implementation
 */

import type { Party, Connection } from 'partyserver';

/**
 * ContainerStartOptions as they come from worker types
 */
export type ContainerStartOptions = Partial<
  NonNullable<Parameters<NonNullable<DurableObject['ctx']['container']>['start']>[0]>
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

  /** If true, container won't be started automatically when the durable object starts */
  explicitContainerStart?: boolean;

  /** If true, container won't be started automatically when the durable object starts (preferred over explicitContainerStart) */
  manualStart?: boolean;
}

/**
 * Context provided to container methods
 */
export interface ContainerContext {
  id: string;
  party: Party;
  request?: Request;
  connection?: Connection;
}

/**
 * Function to handle container events
 */
export type ContainerEventHandler = () => void | Promise<void>;

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
