import { WranglerDevRunner } from '../../helpers/index.js';
import { test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

describe('core functionality', () => {
  describe('local', async () => {
    test('http fetch (and onStart and onStop hooks)', async () => {
      const runner = new WranglerDevRunner();
      const url = await runner.getUrl();
      // so each test is to a unique container
      const id = randomUUID();
      const response = await vi.waitFor(
        async () => {
          const res = await fetch(`${url}/fetch?id=${id}`);
          if (res.status !== 200) {
            throw new Error(`Expected status 200, got ${res.status}`);
          }
          return res;
        },
        { timeout: 10000 }
      );

      const responseText = await response.text();
      expect(responseText).toBe('Hello from test container! process.env.MESSAGE: default message');

      await runner.stop([id]);

      const output = runner.getStdout();

      expect(output.match(/onStart hook called/g)).toHaveLength(1);
      expect(output.match(/onStop hook called/g)).toHaveLength(1);
    });

    test('containerFetch', async () => {
      const runner = new WranglerDevRunner();

      const url = await runner.getUrl();
      const id = randomUUID();

      const response = await vi.waitFor(
        async () => {
          const res = await fetch(`${url}/containerFetch?id=${id}`);
          if (res.status !== 200) {
            console.log(await res.text());
            throw new Error(`Expected status 200, got ${res.status}`);
          }
          return res;
        },
        { timeout: 10000 }
      );

      const responseText = await response.text();

      expect(responseText).toBe('Hello from test container! process.env.MESSAGE: default message');
      await runner.stop([id]);
      const output = runner.getStdout();
      expect(output.match(/onStart hook called/g)).toHaveLength(1);
    });

    test('startAndWaitForPorts', async () => {
      const runner = new WranglerDevRunner();

      const url = await runner.getUrl();
      const id = randomUUID();
      await fetch(`${url}/startAndWaitForPorts?id=${id}`);

      const response = await fetch(`${url}/fetch?id=${id}`);
      const responseText = await response.text();

      expect(responseText).toBe(
        'Hello from test container! process.env.MESSAGE: start with startAndWaitForPorts'
      );
      await runner.stop([id]);
      const output = runner.getStdout();
      expect(output.match(/onStart hook called/g)).toHaveLength(1);
      const onStartIndex = output.indexOf('onStart hook called');
      const fetchRequestIndex = output.indexOf('Handling http fetch request');
      expect(onStartIndex).toBeLessThan(fetchRequestIndex);
    });

    test('start', async () => {
      const runner = new WranglerDevRunner();

      const url = await runner.getUrl();
      const id = randomUUID();

      await fetch(`${url}/start?id=${id}`);

      const response = await fetch(`${url}/fetch?id=${id}`);
      const responseText = await response.text();

      expect(responseText).toBe('Hello from test container! process.env.MESSAGE: start with start');

      await runner.stop([id]);
      const output = runner.getStdout();

      // we seem to call onStart when stopped -> running and running -> healthy
      // when we call start we go from stopped -> running,
      // and we only register healthy when we call containerFetch which calls startAndWaitForPorts
      // compare the test above, where we after calling startAndWaitForPorts
      // we only see one onStart because we go straight from stopped -> healthy
      expect(output.match(/onStart hook called/g)).toHaveLength(2);
      const firstOnStartIndex = output.indexOf('onStart hook called');
      const fetchRequestIndex = output.indexOf('Handling http fetch request');
      const secondOnStartIndex = output.indexOf('onStart hook called', firstOnStartIndex + 1);
      expect(firstOnStartIndex).toBeLessThan(fetchRequestIndex);
      expect(fetchRequestIndex).toBeLessThan(secondOnStartIndex);
    });
  });

  // TODO: test against deployed containers
});
