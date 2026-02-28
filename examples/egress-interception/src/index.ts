// import { Container, getRandom, getContainer } from '@cloudflare/containers'; // in a real Worker
import { Container, getRandom, getContainer } from '../../../src/index.js';
export { ContainerProxy } from '../../../src/index.js';
import { OutboundHandlerContext } from '../../../src/lib/container.js';

export class MyContainer extends Container {
  defaultPort = 8080; // The default port for the container to listen on
  sleepAfter = '10h'; // Sleep the container if no requests are made in this timeframe
  enableInternet = false;

  // default env vars to set in the container when starting
  envVars = {
    MESSAGE: 'I was passed in via the container class!',
  };

  static outboundHandlers = {
    'google.com': (_req: Request, ctx: OutboundHandlerContext) => {
      return new Response('hi 2 ' + ctx.containerId + 'i am google');
    },
  };
}

export default {
  async fetch(
    request: Request,
    env: { MY_CONTAINER: DurableObjectNamespace<MyContainer> }
  ): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    // If you want to route requests to a specific container,
    // pass a unique container identifier to .get()

    if (pathname.startsWith('/container')) {
      const containerInstance = getContainer(env.MY_CONTAINER, pathname);
      return containerInstance.fetch(request);
    }

    if (pathname.startsWith('/error')) {
      const containerInstance = getContainer(env.MY_CONTAINER, 'error-test');
      return containerInstance.fetch(request);
    }

    if (pathname.startsWith('/lb')) {
      const containerInstance = await getRandom(env.MY_CONTAINER, 3);
      return containerInstance.fetch(request);
    }

    if (pathname.startsWith('/singleton')) {
      if (pathname.includes('stop')) {
        await getContainer(env.MY_CONTAINER).destroy();
        try {
          await getContainer(env.MY_CONTAINER).abort();
        } catch {}
        return new Response('ok');
      }

      // getContainer will return a specific instance if no second argument is provided
      return getContainer(env.MY_CONTAINER).fetch(request);
    }

    return new Response(
      'Call /container to start a container with a 10s timeout.\nCall /error to start a container that errors\nCall /lb to test load balancing\nCall /singleton to get a singleton container instance'
    );
  },
};
