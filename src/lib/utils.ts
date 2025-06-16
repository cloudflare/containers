import type { Container } from './container';

/**
 * Load balance requests across multiple container instances
 * @param binding The Container's Durable Object binding
 * @param instances Number of instances to load balance across
 * @returns A promise resolving to a container stub ready to handle requests
 */
export async function loadBalance<T extends Container>(
  binding: DurableObjectNamespace<T>,
  instances: number = 3
): Promise<DurableObjectStub<T>> {
  // Generate a random ID within the range of instances
  const id = Math.floor(Math.random() * instances).toString();

  // Always use idFromName for consistent behavior
  // idFromString requires a 64-hex digit string which is hard to generate
  const objectId = binding.idFromName(`instance-${id}`);

  // Return the stub for the selected instance
  return binding.get(objectId);
}

/**
 * Get a container stub
 * @param binding The Container's Durable Object binding
 * @param name The name of the instance to get, uses 'cf-singleton-container' by default
 * @returns A container stub ready to handle requests
 */
export const singletonContainerId = 'cf-singleton-container';
export function getContainer<T extends Container>(
  binding: DurableObjectNamespace<T>
): DurableObjectStub<T> {
  const objectId = binding.idFromName(singletonContainerId);
  return binding.get(objectId);
}
