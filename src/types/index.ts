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

export type State = {
  status: 'running' | 'stopped';
};

export type Signal = 'SIGKILL' | 'SIGINT' | 'SIGTERM';
export type SignalInteger = number;
