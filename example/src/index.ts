import { Container, loadBalance } from 'cf-containers';

export class MyContainer extends Container {
  override defaultPort = 8080;
  override sleepAfter = '10s';
  override startOptions = {
    env: {
      MESSAGE: 'I was passed in via the container class!',
    },
  };

  override onStart() {
    console.log('Container successfully started');
  }

  override onStop() {
    console.log('Container successfully shut down');
  }

  override onError(error: unknown) {
    console.log('Container error:', error);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    // If you want to route requests to a specific container,
    // pass a unique container identifier to .get()

    if (pathname.startsWith('/container')) {
      let id = env.MY_CONTAINER.idFromName('container');
      let container = env.MY_CONTAINER.get(id);
      return await container.fetch(request);
    }

    if (pathname.startsWith('/error')) {
      let id = env.MY_CONTAINER.idFromName('error-test');
      let container = env.MY_CONTAINER.get(id);
      return await container.fetch(request);
    }

    if (pathname.startsWith('/lb')) {
      let container = await loadBalance(env.MY_CONTAINER, 3);
      return await container.fetch(request);
    }

    return new Response(
      'call /container to start a container with a 10s timeout.\nCall /error to start a container that errors\nCall /lb to test load balancing'
    );
  },
};
