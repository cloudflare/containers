// import { Container, getRandom, getContainer } from '@cloudflare/containers'; // in a real Worker
import { Container, getContainer } from '../../../src/index.js';
export { ContainerProxy } from '../../../src/index.js';
import { OutboundHandlerContext } from '../../../src/lib/container.js';

export class MyContainer extends Container {
  defaultPort = 8080; // The default port for the container to listen on
  sleepAfter = '10s'; // Sleep the container if no requests are made in this timeframe
  enableInternet = false;
  interceptHttps = true;
  allowedHosts = ['example.com', '*.google.com'];
  deniedHosts = ['example2.com'];

  // default env vars to set in the container when starting
  envVars = {
    MESSAGE: 'I was passed in via the container class!',
  };

  static outboundByHost = {
    '*.google.com': (_req: Request, _env: unknown, ctx: OutboundHandlerContext) => {
      return new Response('Hi, ' + ctx.containerId + ' I am google');
    },
    'google.com': (_req: Request, _env: unknown, ctx: OutboundHandlerContext) => {
      return new Response('Hi, ' + ctx.containerId + ' I am google');
    },
  };

  static outboundHandlers = {
    async github(_req: Request, _env: unknown, ctx: OutboundHandlerContext<{ hello: string }>) {
      return new Response('I am github, ' + ctx.params?.hello);
    },
  };

  static outbound = (req: Request) => {
    return new Response(`Hi ${req.url}, I can't handle you`);
  };
}

export default {
  async fetch(
    request: Request,
    env: { MY_CONTAINER: DurableObjectNamespace<MyContainer> }
  ): Promise<Response> {
    if (!request.url.includes('proxy=') && !request.url.includes('proxy_https=')) {
      return new Response('?proxy= or ?proxy_https= param should be set to point to a domain');
    }

    // getContainer will return a specific instance if no second argument is provided
    const container = getContainer(env.MY_CONTAINER, 'hello3');

    return await container.fetch(request);
  },
};
