import type { Container } from './container';

/**
 * Get a random container instances across N instances
 * @param binding The Container's Durable Object binding
 * @param instances Number of instances to load balance across
 * @returns A promise resolving to a container stub ready to handle requests
 */
export async function getRandom<T extends Container>(
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
 * Deprecated funtion to get random container instances. Renamed to getRandom
 * @param binding The Container's Durable Object binding
 * @param instances Number of instances to load balance across
 * @returns A promise resolving to a container stub ready to handle requests
 */
export async function loadBalance<T extends Container>(
  binding: DurableObjectNamespace<T>,
  instances: number = 3
): Promise<DurableObjectStub<T>> {
  console.warn(
    'loadBalance is deprecated, please use getRandom instead. This will be removed in a future version.'
  );
  return getRandom(binding, instances);
}

/**
 * Get a container stub
 * @param binding The Container's Durable Object binding
 * @param name The name of the instance to get, uses 'cf-singleton-container' by default
 * @returns A container stub ready to handle requests
 */
export const singletonContainerId = 'cf-singleton-container';
export function getContainer<T extends Container>(
  binding: DurableObjectNamespace<T>,
  name?: string
): DurableObjectStub<T> {
  const objectId = binding.idFromName(name ?? singletonContainerId);
  return binding.get(objectId);
}

/**
 * Return a request with the port target set correctly
 * You can use this method when you have to use `fetch` and not `containerFetch` with as it's a JSRPC method and it
 * comes with some consequences like not being able to pass WebSockets.
 *
 * @example container.fetch(switchPort(request, 8090));
 */
export function switchPort(request: Request, port: number): Request {
  const url = new URL(request.url);
  url.port = `${port}`;
  return new Request(url, request);
}
