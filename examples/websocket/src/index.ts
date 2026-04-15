import { Container } from '../../../src/lib/container';
import { getContainer } from '../../../src/lib/utils';

/**
 * WebSocket Test Container implementation for integration testing
 * Supports WebSocket connections and both fetch methods
 */
export class WebSocketTestContainer extends Container {
  defaultPort = 8080;
  // Set how long the container should stay active without requests
  sleepAfter = '10s';
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

    if (url.pathname === '/ws') {
      // Create a WebSocket upgrade request to the container
      const wsRequest = new Request('http://container/ws', {
        headers: { Upgrade: 'websocket' },
      });
      const response = await container.fetch(wsRequest);
      const containerWs = response.webSocket;
      if (!containerWs) {
        return new Response('Failed to establish WebSocket with container', { status: 500 });
      }
      containerWs.accept();

      // Send ping to the container
      containerWs.send('ping');

      // Wait for the pong response
      const pong = await new Promise<string>(resolve => {
        containerWs.addEventListener('message', (event: MessageEvent) => {
          resolve(event.data as string);
        });
      });

      containerWs.close();

      return new Response(pong);
    }

    if (url.pathname === '/fetch/ws') {
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
