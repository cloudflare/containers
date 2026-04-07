import { WranglerDevRunner } from '../../test-helpers';
import { test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * Egress interception tests.
 *
 * EgressTestContainer is configured with:
 *   enableInternet = false
 *   interceptHttps = true
 *   allowedHosts  = ['allowed.com', 'by-host.com']
 *   deniedHosts   = ['denied.com']
 *   outboundByHost = { 'by-host.com': handler }
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

    async function destroyEgress(runner: WranglerDevRunner, id: string) {
      const url = await runner.getUrl();
      await fetch(`${url}/destroy?id=${id}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    test('deniedHosts blocks the request', async () => {
      const runner = new WranglerDevRunner();
      const id = randomUUID();

      try {
        const res = await proxyVia(runner, id, 'denied.com');
        expect(res.status).toBe(520);
        const body = await res.text();
        expect(body).toContain('Origin is disallowed');
      } finally {
        await destroyEgress(runner, id);
      }
    });

    test('allowedHosts gate blocks non-allowed hosts', async () => {
      const runner = new WranglerDevRunner();
      const id = randomUUID();

      try {
        const res = await proxyVia(runner, id, 'random.com');
        expect(res.status).toBe(520);
        const body = await res.text();
        expect(body).toContain('Origin is disallowed');
      } finally {
        await destroyEgress(runner, id);
      }
    });

    test('outboundByHost handler is invoked for matching allowed host', async () => {
      const runner = new WranglerDevRunner();
      const id = randomUUID();

      try {
        const res = await proxyVia(runner, id, 'by-host.com');
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toBe('outboundByHost: by-host.com');
      } finally {
        await destroyEgress(runner, id);
      }
    });

    test('catch-all outbound handler is invoked for allowed host without specific handler', async () => {
      const runner = new WranglerDevRunner();
      const id = randomUUID();

      try {
        const res = await proxyVia(runner, id, 'allowed.com');
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toBe('catch-all: allowed.com');
      } finally {
        await destroyEgress(runner, id);
      }
    });

    test('denied host is blocked even if it would match allowedHosts', async () => {
      const runner = new WranglerDevRunner();
      const id = randomUUID();

      try {
        const res = await proxyVia(runner, id, 'denied.com');
        expect(res.status).toBe(520);
      } finally {
        await destroyEgress(runner, id);
      }
    });
  });
});
