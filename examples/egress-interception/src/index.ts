// import { Container, getRandom, getContainer } from '@cloudflare/containers'; // in a real Worker
import { Container, getRandom, getContainer } from '../../../src/index.js';
export { ContainerProxy } from '../../../src/index.js';
import { OutboundHandler, OutboundHandlerContext } from '../../../src/lib/container.js';

export class MyContainer extends Container {
  defaultPort = 8080; // The default port for the container to listen on
  sleepAfter = '10h'; // Sleep the container if no requests are made in this timeframe
  override enableInternet = false;

  // default env vars to set in the container when starting
  envVars = {
    MESSAGE: 'I was passed in via the container class!',
  };

  static outboundHandlers = {
    'google.com': (_req: Request, _env: unknown, ctx: OutboundHandlerContext) => {
      return new Response('hi 2 ' + ctx.containerId + 'i am google');
    },
  };

  static outboundProxies = {
    async github() {
      return new Response('i am github');
    },
  };

  static outboundProxy = (req: Request) => {
    return new Response(`Hi ${req.url}, I can't handle you`);
  };
}

export default {
  async fetch(
    request: Request,
    env: { MY_CONTAINER: DurableObjectNamespace<MyContainer> }
  ): Promise<Response> {
    if (!request.url.includes('proxy=')) {
      return new Response('?proxy= param should be set to point to a domain');
    }

    // getContainer will return a specific instance if no second argument is provided
    const container = getContainer(env.MY_CONTAINER);

    await container.addOutboundHandle('github.com', 'github');
    return container.fetch(request);
  },
};
