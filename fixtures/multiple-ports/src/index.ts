import { Container } from '../../../src/lib/container';
import { getContainer, getRandom, switchPort } from '../../../src/lib/utils';

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

    if (url.pathname === '/startAndWaitFor8080') {
      // waits for default port 8080 only
      await container.startAndWaitForPorts({
        startOptions: {
          envVars: { MESSAGE: 'start with startAndWaitForPorts' },
        },
      });
      return new Response('start request sent waiting for 8080');
    }
    if (url.pathname === '/startAndWaitForAllPorts') {
      // waits for default port 8080 only
      await container.startAndWaitForPorts({
        startOptions: {
          envVars: { MESSAGE: 'start with startAndWaitForPorts' },
        },
        ports: [8080, 8081],
      });
      return new Response('start request sent waiting for all ports');
    }
    if (url.pathname === '/server-one') {
      return container.containerFetch(request, 8080);
    }
    if (url.pathname === '/server-two') {
      return container.containerFetch(request, 8081);
    }
    if (url.pathname === '/start') {
      await container.start({
        envVars: { MESSAGE: 'start with start' },
      });
      return new Response('start request sent');
    }
    if (url.pathname === '/waitForPort') {
      const portToCheck = parseInt(url.searchParams.get('port') || '8080');
      await container.waitForPort({ portToCheck });
      return new Response('port');
    }

    if (url.pathname === '/stop') {
      await container.destroy();
      return new Response('Container stopping');
    }
    return new Response('Not Found');
  },
};
