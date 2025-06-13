import { Container } from '../lib/container';
import { loadBalance, getContainer } from '../lib/utils';

/**
 * Example container for load balancing
 */
export class MyContainer extends Container {
  defaultPort = 8080;
}

/**
 * Type for environment with Container binding
 */
interface Env {
  MY_CONTAINER: DurableObjectNamespace;
}

/**
 * Example worker that uses load balancing
 */
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    try {
      // Example: Load balance across 5 container instances
      if (url.pathname === '/api') {
        const containerInstance = await loadBalance(env.MY_CONTAINER, 5);
        return await containerInstance.fetch(request);
      }

      // Example: Direct request to a specific container
      if (url.pathname.startsWith('/specific/')) {
        const id = url.pathname.split('/')[2] || 'default';
        const containerInstance = getContainer(env.MY_CONTAINER, id);
        return await containerInstance.fetch(request);
      }

      return new Response('Not found', { status: 404 });
    } catch (error) {
      console.error('Error handling request:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  }
};