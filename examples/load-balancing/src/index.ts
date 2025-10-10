import { Container } from '../../../src/lib/container';
import { getContainer, getRandom } from '../../../src/lib/utils';

export class LoadBalancingContainer extends Container {
  // Default port the container listens on.
  defaultPort = 8080;
  // Set how long the container should stay active without requests
  sleepAfter = '3m';
}

export default {
  async fetch(
    request: Request,
    env: { CONTAINER: DurableObjectNamespace<LoadBalancingContainer> }
  ): Promise<Response> {
    const url = new URL(request.url);

    try {
      // Load balance across 5 container instances
      if (url.pathname === '/api') {
        // Every time we hit this endpoint, we get one of 5 containers, at random
        const containerInstance = await getRandom(env.CONTAINER, 5);
        return await containerInstance.fetch(request);
      }

      // Direct request to a specific container
      if (url.pathname.startsWith('/specific/')) {
        const id = url.pathname.split('/')[2] || 'default';
        const containerInstance = getContainer(env.CONTAINER, id);
        return await containerInstance.fetch(request);
      }
      return new Response('Load balancing fixture endpoint not found', { status: 404 });
    } catch (error) {
      console.error('Error handling load balancing request:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};
