import { Container } from '../../../src/lib/container';
import { getContainer, switchPort } from '../../../src/lib/utils';

/**
 * Test Container implementation for integration testing
 */
export class TestContainer extends Container {
  defaultPort = 8080;

  // Set how long the container should stay active without requests
  sleepAfter = '3m';

  constructor(ctx: any, env: any) {
    super(ctx, env);

    // Set container configuration
    this.envVars = {
      MESSAGE: 'default message',
    };
    this.entrypoint = ['node', 'server.js'];
  }

  override async onStart(): Promise<void> {
    console.log('onStart hook called');
  }

  override async onStop(): Promise<void> {
    console.log('onStop hook called');
  }

  override onError(error: unknown): any {
    console.log('onError hook called with error:', error);
    throw error;
  }
}

export default {
  async fetch(
    request: Request,
    env: { CONTAINER: DurableObjectNamespace<TestContainer> }
  ): Promise<Response> {
    const url = new URL(request.url);
    // get a new container instance per request

    const id = url.searchParams.get('id') || 'singleton';
    const container = getContainer(env.CONTAINER, id);
    if (url.pathname === '/status') {
      const state = await container.getState();
      return new Response(JSON.stringify(state, null, 2));
    }
    if (url.pathname === '/startAndWaitForPorts') {
      await container.startAndWaitForPorts({
        startOptions: { envVars: { MESSAGE: 'start with startAndWaitForPorts' } },
      });
      return new Response('start request sent');
    }
    if (url.pathname === '/start') {
      await container.start({
        envVars: { MESSAGE: 'start with start' },
      });
      return new Response('start request sent');
    }
    if (url.pathname === '/containerFetch') {
      console.log('Handling containerFetch request');
      return container.containerFetch(request);
    }
    if (url.pathname === '/fetch') {
      console.log('Handling http fetch request');
      return container.fetch(request);
    }
    if (url.pathname === '/fetchWithSwitchPort') {
      return container.fetch(switchPort(request, 8080));
    }
    if (url.pathname === '/destroy') {
      await container.destroy();
      return new Response('Container killed');
    }

    if (url.pathname === '/stop') {
      await container.stop();
      return new Response('Container stopping');
    }
    return new Response('Not Found');
  },
};
