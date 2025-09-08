import { WranglerDevRunner } from '../../helpers/index.js';
import { test, expect, describe } from 'vitest';
import { randomUUID } from 'node:crypto';

const fetchOrTimeout = async (fetchPromise: Promise<Response>, timeoutMs: number) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), timeoutMs)
  );
  return await Promise.race([fetchPromise, timeoutPromise]);
};

describe('multiple ports functionality', () => {
  test('waitForPort should wait for port to be ready before returning', async () => {
    const runner = new WranglerDevRunner();
    const url = await runner.getUrl();
    const id = randomUUID();

    // This only waits for the default port 8080 to be ready
    await fetch(`${url}/startAndWaitFor8080?id=${id}`);

    // first server should be ready immediately
    let fetchPromise = fetch(`${url}/server-one?id=${id}`);
    let res = (await fetchOrTimeout(fetchPromise, 1000)) as Response;
    expect(await res.text()).toBe(
      'Hello from test container server one! process.env.MESSAGE: start with startAndWaitForPorts'
    );

    // Second server listening on 8081 should not be ready yet - this call should not resolve within 1s
    fetchPromise = fetch(`${url}/server-two?id=${id}`);
    expect(fetchOrTimeout(fetchPromise, 1000)).rejects.toThrow('timeout');

    // Wait for the default port (8080) to be ready

    await fetch(`${url}/waitForPort?id=${id}&port=8081`);

    // Verify the container is actually ready by making a request
    fetchPromise = fetch(`${url}/server-two?id=${id}`);
    res = (await fetchOrTimeout(fetchPromise, 1000)) as Response;
    expect(await res.text()).toBe(
      'Hello from test container server two! process.env.MESSAGE: start with startAndWaitForPorts'
    );

    await runner.stop([id]);
  });

  test('startAndWaitForPorts should wait for all specified ports to be ready', async () => {
    const runner = new WranglerDevRunner();
    const url = await runner.getUrl();
    const id = randomUUID();

    // Start and wait for ports should wait for all ports to be ready
    await fetch(`${url}/startAndWaitForAllPorts?id=${id}`);

    // first server should be ready immediately
    let fetchPromise = fetch(`${url}/server-one?id=${id}`);
    let res = (await fetchOrTimeout(fetchPromise, 1000)) as Response;
    expect(await res.text()).toBe(
      'Hello from test container server one! process.env.MESSAGE: start with startAndWaitForPorts'
    );

    // second server should be ready immediately
    fetchPromise = fetch(`${url}/server-two?id=${id}`);
    res = (await fetchOrTimeout(fetchPromise, 1000)) as Response;
    expect(await res.text()).toBe(
      'Hello from test container server two! process.env.MESSAGE: start with startAndWaitForPorts'
    );

    await runner.stop([id]);
  });
});
