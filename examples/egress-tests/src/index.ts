import { Container } from '../../../src/lib/container';
import { getContainer } from '../../../src/lib/utils';

export { ContainerProxy } from '../../../src/lib/container';

export class EgressTestContainer extends Container {
  defaultPort = 8080;
  sleepAfter = '3m';
  enableInternet = false;
  interceptHttps = true;

  // allowedHosts gates everything: only these hosts can reach outbound/internet.
  // 'by-host.com' is included so the outboundByHost handler can run.
  allowedHosts = ['allowed.com', 'by-host.com', '*.globtest.com'];
  deniedHosts = ['denied.com'];

  constructor(ctx: any, env: any) {
    super(ctx, env);
    this.entrypoint = ['node', 'server.js'];
    this.envVars = {
      NODE_EXTRA_CA_CERTS: '/etc/cloudflare/certs/cloudflare-containers-ca.crt',
    };
  }
}

EgressTestContainer.outboundByHost = {
  'by-host.com': (_req: Request) => {
    return new Response('outboundByHost: by-host.com');
  },
  '*.globtest.com': (req: Request) => {
    return new Response('outboundByHost glob: ' + new URL(req.url).hostname);
  },
};

EgressTestContainer.outbound = (req: Request) => {
  return new Response('catch-all: ' + new URL(req.url).hostname);
};

export default {
  async fetch(
    request: Request,
    env: { CONTAINER: DurableObjectNamespace<EgressTestContainer> }
  ): Promise<Response> {
    try {
      const url = new URL(request.url);
      const id = url.searchParams.get('id') || 'singleton';
      const container = getContainer(env.CONTAINER, id);

      if (url.pathname === '/proxy') {
        return await container.containerFetch(request);
      }
      if (url.pathname === '/proxy_https') {
        return await container.containerFetch(request);
      }
      if (url.pathname === '/config/deny-host') {
        const hostname = url.searchParams.get('hostname');
        if (!hostname) {
          return new Response('hostname is required', { status: 400 });
        }

        await container.denyHost(hostname);
        return new Response('OK');
      }
      if (url.pathname === '/destroy') {
        await container.destroy();
        return new Response('Container killed');
      }
      if (url.pathname === '/status') {
        const state = await container.getState();
        return new Response(JSON.stringify(state, null, 2));
      }

      return new Response('Not Found');
    } catch (e) {
      console.error('Worker fetch error:', e);
      return new Response(`Worker error: ${e instanceof Error ? e.message : String(e)}`, {
        status: 500,
      });
    }
  },
};
