import { randomUUID } from 'node:crypto';
import { describe, expect, vi } from 'vitest';
import { test, WranglerDevRunner } from '../../test-helpers';

/**
 * Egress interception tests.
 *
 * EgressTestContainer is configured with:
 *   enableInternet = false
 *   interceptHttps = true
 *   allowedHosts  = ['allowed.com', 'by-host.com', '*.globtest.com']
 *   deniedHosts   = ['denied.com']
 *   outboundByHost = { 'by-host.com': handler, '*.globtest.com': handler }
 *   outbound       = catch-all handler
 */
describe('egress interception', () => {
  describe('local', () => {
    async function proxyVia(
      runner: WranglerDevRunner,
      id: string,
      target: string
    ): Promise<Response> {
      const url = await runner.getUrl();
      return vi.waitFor(
        async () => {
          const res = await fetch(`${url}/proxy?id=${id}&proxy=${encodeURIComponent(target)}`);
          if (res.status === 500 || res.status === 503) {
            throw new Error(`Container not ready, got ${res.status}`);
          }
          return res;
        },
        { timeout: 15000 }
      );
    }

    async function destroyContainer(runner: WranglerDevRunner, id: string) {
      // Tell the worker to destroy the container so the in-container onStop
      // hook can fire before the fixture tears down wrangler dev itself.
      // The full wrangler+workerd cleanup is handled automatically by the
      // `runner` test fixture.
      const url = await runner.getUrl();
      await fetch(`${url}/destroy?id=${id}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    async function denyHost(runner: WranglerDevRunner, id: string, hostname: string) {
      const url = await runner.getUrl();
      const res = await fetch(
        `${url}/config/deny-host?id=${id}&hostname=${encodeURIComponent(hostname)}`
      );
      expect(res.status).toBe(200);
    }

    test('deniedHosts blocks the request', async ({ runner }) => {
      const id = randomUUID();

      const res = await proxyVia(runner, id, 'denied.com');
      expect(res.status).toBe(520);
      const body = await res.text();
      expect(body).toContain('Origin is disallowed');

      await destroyContainer(runner, id);
    });

    test('allowedHosts gate blocks non-allowed hosts', async ({ runner }) => {
      const id = randomUUID();

      const res = await proxyVia(runner, id, 'random.com');
      expect(res.status).toBe(520);
      const body = await res.text();
      expect(body).toContain('Origin is disallowed');

      await destroyContainer(runner, id);
    });

    test('outboundByHost handler is invoked for matching allowed host', async ({ runner }) => {
      const id = randomUUID();

      const res = await proxyVia(runner, id, 'by-host.com');
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe('outboundByHost: by-host.com');

      await destroyContainer(runner, id);
    });

    test('catch-all outbound handler is invoked for allowed host without specific handler', async ({
      runner,
    }) => {
      const id = randomUUID();

      const res = await proxyVia(runner, id, 'allowed.com');
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe('catch-all: allowed.com');

      await destroyContainer(runner, id);
    });

    test('denied host is blocked even if it would match allowedHosts', async ({ runner }) => {
      const id = randomUUID();

      const res = await proxyVia(runner, id, 'denied.com');
      expect(res.status).toBe(520);

      await destroyContainer(runner, id);
    });

    test('glob pattern in outboundByHost matches subdomains', async ({ runner }) => {
      const id = randomUUID();

      const res = await proxyVia(runner, id, 'api.globtest.com');
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe('outboundByHost glob: api.globtest.com');

      await destroyContainer(runner, id);
    });

    test('glob pattern in outboundByHost matches deeply nested subdomains', async ({ runner }) => {
      const id = randomUUID();

      const res = await proxyVia(runner, id, 'a.b.globtest.com');
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe('outboundByHost glob: a.b.globtest.com');

      await destroyContainer(runner, id);
    });

    test('glob pattern in allowedHosts blocks non-matching host', async ({ runner }) => {
      const id = randomUUID();

      // globtest.com itself does NOT match *.globtest.com
      const res = await proxyVia(runner, id, 'globtest.com');
      expect(res.status).toBe(520);

      await destroyContainer(runner, id);
    });

    test('denyHost also blocks the same hostname with a trailing dot', async ({ runner }) => {
      const id = randomUUID();
      const hostname = `allowed-${randomUUID()}.example.com`;

      await denyHost(runner, id, hostname);

      const res = await proxyVia(runner, id, `${hostname}.`);
      expect(res.status).toBe(520);
      const body = await res.text();
      expect(body).toContain('Origin is disallowed');

      await destroyContainer(runner, id);
    });
  });
});
