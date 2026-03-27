import { Container, getRandom, getContainer } from '@cloudflare/containers'; // in a real Worker
import { WorkerEntrypoint } from 'cloudflare:workers';
// import { Container, getRandom, getContainer } from '../../../src/index.js';
//
export class MyWorker extends WorkerEntrypoint {
  async fetch() {
    return new Response('WHAT IS HAPPENING');
  }
}

export class MyContainer extends Container {
  defaultPort = 8080; // The default port for the container to listen on
  sleepAfter = '6m'; // Sleep the container if no requests are made in this timeframe

  // default env vars to set in the container when starting
  envVars = {
    MESSAGE: 'I was passed in via the container class!',
  };

  async setIt() {
    const worker = this.ctx.exports.MyWorker();
    await this.ctx.container.interceptOutboundHttp('15.0.0.1:80', worker);
  }

  // these lifecycle hooks are called whenever the container starts, stops, or errors
  override onStart() {
    console.log('Container successfully started');
  }

  override onStop() {
    console.log('Container successfully shut down');
  }

  override onError(error: unknown) {
    console.log('Container error:', error);
  }

  static outbound = async () => {
    return new Response('whats up');
  };

  static outboundByHost = {
    'mikenomitch.com': (_req: Request, _env: unknown, ctx: any) => {
      return new Response('Hi, ' + ctx.containerId + ' I am google');
    },
  };
}

// Intercept outbound HTTP from the container to mikenomitch.com and
// fetch the real origin on its behalf (egress proxy).
// TODO: remove cast once @cloudflare/containers types include outboundByHost
MyContainer.outboundByHost = {
  'mikenomitch.com': async (request: Request) => {
    // const url = new URL(request.url);
    // url.hostname = 'mikenomitch.com';
    // url.protocol = 'https:';
    // return fetch(new Request(url.toString(), request));
    return new Response('hey');
  },
};

MyContainer.outbound = async () => {
  return new Response('WAT');
};

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

    if (pathname.startsWith('/egress')) {
      // Forward to the container's /egress endpoint, which makes an outbound
      // request to ?origin=. Traffic to mikenomitch.com is intercepted by the
      // outboundByHost handler above.
      const container = getContainer(env.MY_CONTAINER, 'egress');
      await container.setIt();
      return container.fetch(request);
    }

    if (pathname.startsWith('/singleton')) {
      // getContainer will return a specific instance if no second argument is provided
      return getContainer(env.MY_CONTAINER).fetch(request);
    }

    return new Response(
      'Call /container to start a container with a 10s timeout.\nCall /error to start a container that errors\nCall /lb to test load balancing\nCall /singleton to get a singleton container instance\nCall /egress?origin=http://mikenomitch.com to test egress via outbound worker'
    );
  },
};
