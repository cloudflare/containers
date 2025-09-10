import { Container } from '../../../src/lib/container';
import { getContainer } from '../../../src/lib/utils';

/**
 * WebSocket Test Container implementation for integration testing
 * Supports WebSocket connections and both fetch methods
 */
export class WebSocketTestContainer extends Container {
  defaultPort = 8080;
  // Set how long the container should stay active without requests
  sleepAfter = '3m';
  envVars = {
    MESSAGE: 'websocket default message',
  };
  entrypoint = ['node', 'server.js'];
}

export default {
  async fetch(
    request: Request,
    env: { CONTAINER: DurableObjectNamespace<WebSocketTestContainer> }
  ): Promise<Response> {
    const url = new URL(request.url);

    // get a container instance based on id query param or use singleton
    const id = url.searchParams.get('id') || 'singleton';
    const container = getContainer(env.CONTAINER, id);

    if (url.pathname === '/fetch/ws') {
      console.log('Handling WebSocket fetch request');
      const wsRequest = new Request('http://example/ws', {
        method: request.method,
        headers: request.headers,
      });
      return container.fetch(wsRequest);
    }

    if (url.pathname === '/stop') {
      await container.destroy();
      return new Response('WebSocket container stopping');
    }
    return new Response('WebSocket fixture endpoint not found');
  },
};
