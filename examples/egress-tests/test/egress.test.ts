import { randomUUID } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

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
  const baseUrl = process.env.EGRESS_TEST_BASE_URL;

  if (!baseUrl) {
    throw new Error('EGRESS_TEST_BASE_URL must be set to the deployed Worker URL.');
  }

  describe(process.env.EGRESS_TEST_ENV ?? 'deployed', () => {
    async function proxyVia(id: string, target: string): Promise<Response> {
      let lastResponse = '';
      try {
        return await vi.waitFor(
          async () => {
            const res = await fetch(`${baseUrl}/proxy?id=${id}&proxy=${encodeURIComponent(target)}`);
            if (res.status === 500 || res.status === 503) {
              lastResponse = await res.text();
              throw new Error(`Container not ready, got ${res.status}: ${lastResponse}`);
            }
            return res;
          },
          { timeout: 120000 }
        );
      } catch (error) {
        if (lastResponse) {
          throw new Error(`${error instanceof Error ? error.message : String(error)}
Last response: ${lastResponse}`);
        }
        throw error;
      }
    }

    async function destroyContainer(id: string) {
      await fetch(`${baseUrl}/destroy?id=${id}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    async function denyHost(id: string, hostname: string) {
      const res = await fetch(
        `${baseUrl}/config/deny-host?id=${id}&hostname=${encodeURIComponent(hostname)}`
      );
      expect(res.status).toBe(200);
    }

    test('deniedHosts blocks the request', async () => {
      const id = randomUUID();

      const res = await proxyVia(id, 'denied.com');
      expect(res.status).toBe(520);
      const body = await res.text();
      expect(body).toContain('Origin is disallowed');

      await destroyContainer(id);
    });

    test('allowedHosts gate blocks non-allowed hosts', async () => {
      const id = randomUUID();

      const res = await proxyVia(id, 'random.com');
      expect(res.status).toBe(520);
      const body = await res.text();
      expect(body).toContain('Origin is disallowed');

      await destroyContainer(id);
    });

    test('outboundByHost handler is invoked for matching allowed host', async () => {
      const id = randomUUID();

      const res = await proxyVia(id, 'by-host.com');
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe('outboundByHost: by-host.com');

      await destroyContainer(id);
    });

    test('catch-all outbound handler is invoked for allowed host without specific handler', async () => {
      const id = randomUUID();

      const res = await proxyVia(id, 'allowed.com');
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe('catch-all: allowed.com');

      await destroyContainer(id);
    });

    test('denied host is blocked even if it would match allowedHosts', async () => {
      const id = randomUUID();

      const res = await proxyVia(id, 'denied.com');
      expect(res.status).toBe(520);

      await destroyContainer(id);
    });

    test('glob pattern in outboundByHost matches subdomains', async () => {
      const id = randomUUID();

      const res = await proxyVia(id, 'api.globtest.com');
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe('outboundByHost glob: api.globtest.com');

      await destroyContainer(id);
    });

    test('glob pattern in outboundByHost matches deeply nested subdomains', async () => {
      const id = randomUUID();

      const res = await proxyVia(id, 'a.b.globtest.com');
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe('outboundByHost glob: a.b.globtest.com');

      await destroyContainer(id);
    });

    test('glob pattern in allowedHosts blocks non-matching host', async () => {
      const id = randomUUID();

      // globtest.com itself does NOT match *.globtest.com
      const res = await proxyVia(id, 'globtest.com');
      expect(res.status).toBe(520);

      await destroyContainer(id);
    });

    test('denyHost also blocks the same hostname with a trailing dot', async () => {
      const id = randomUUID();
      const hostname = `allowed-${randomUUID()}.example.com`;

      await denyHost(id, hostname);

      const res = await proxyVia(id, `${hostname}.`);
      expect(res.status).toBe(520);
      const body = await res.text();
      expect(body).toContain('Origin is disallowed');

      await destroyContainer(id);
    });
  });
});
