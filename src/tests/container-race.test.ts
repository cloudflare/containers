// Reproduction for https://github.com/cloudflare/containers/issues/173
//
// The error "start() cannot be called on a container that is already running."
// is thrown by workerd's Container::start() at src/workerd/api/container.c++:209
// via JSG_REQUIRE(!running, ...). It guards against the JS-visible `running`
// flag being true.
//
// The race in @cloudflare/containers happens because the readiness path in
// containerFetch -> startAndWaitForPorts -> startContainerIfNotRunning has
// multiple `await` points BEFORE the synchronous `this.container.start(...)`
// call. Each `await` yields the DO input gate, allowing two concurrent
// fetches to both pass the `if (this.container.running) return 0;` early
// exit. Whichever calls start() second hits the workerd JSG_REQUIRE.
//
// This test reproduces the race deterministically: it relies on the
// natural microtask scheduling that `Promise.all([fetchA, fetchB])`
// produces, with mocked storage that yields a microtask on every
// operation (the same shape real DO storage has).

import { describe, expect, test, vi } from 'vitest';

vi.mock(
  'cloudflare:workers',
  () => {
    class MockDurableObject {
      ctx: unknown;
      env: unknown;
      constructor(ctx: unknown, env: unknown) {
        this.ctx = ctx;
        this.env = env;
      }
    }
    class MockWorkerEntrypoint {}
    return {
      DurableObject: MockDurableObject,
      WorkerEntrypoint: MockWorkerEntrypoint,
    };
  }
);

vi.mock('node:async_hooks', () => {
  return {
    AsyncLocalStorage: class MockAsyncLocalStorage {
      getStore() {
        return null;
      }
      run(_store: any, fn: Function) {
        return fn();
      }
    },
  };
});

import { Container } from '../lib/container';

/**
 * Build a mock `ctx` that mimics workerd's behaviour for the race we care
 * about:
 *   - `ctx.container.running` starts false.
 *   - `ctx.container.start()` is synchronous, sets `running = true`, and
 *     throws with the workerd error string when called while already running.
 *   - storage operations (get/put/setAlarm/sync) all return resolved
 *     promises, mirroring real DO storage which always yields a microtask.
 *   - blockConcurrencyWhile is identity (no real serialisation).
 */
function makeMockCtx() {
  const containerState = {
    running: false,
  };

  const start = vi.fn(() => {
    if (containerState.running) {
      // Mirrors workerd src/workerd/api/container.c++:209
      throw new Error('start() cannot be called on a container that is already running.');
    }
    containerState.running = true;
  });

  // Vitest's mockResolvedValue(undefined) gives a microtask boundary, which is
  // the same yield-point real DO storage operations have.
  // tcpPort.fetch is only reached on the success path; the race we want
  // to demonstrate happens earlier, in start(). Returning a Response with
  // explicit `webSocket: null` keeps the success path off the WebSocket
  // branch in containerFetch.
  const tcpPortFetch = vi.fn(
    () =>
      Promise.resolve({
        status: 200,
        webSocket: null,
        body: null,
        headers: new Headers(),
      }) as unknown as Promise<Response>
  );

  const ctx: any = {
    storage: {
      get: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      setAlarm: vi.fn().mockResolvedValue(undefined),
      sync: vi.fn().mockResolvedValue(undefined),
      kv: {
        get: vi.fn(),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      sql: { exec: vi.fn().mockReturnValue([]) },
    },
    blockConcurrencyWhile: vi.fn((fn: () => Promise<unknown>) => fn()),
    abort: vi.fn(),
    id: { toString: vi.fn().mockReturnValue('test-container-id') },
    exports: {
      ContainerProxy: vi.fn().mockReturnValue({ fetch: vi.fn() }),
    },
    container: {
      get running() {
        return containerState.running;
      },
      set running(v: boolean) {
        containerState.running = v;
      },
      start,
      signal: vi.fn(),
      destroy: vi.fn(),
      monitor: vi.fn().mockReturnValue(new Promise(() => {})),
      interceptOutboundHttp: vi.fn().mockResolvedValue(undefined),
      interceptOutboundHttps: vi.fn().mockResolvedValue(undefined),
      interceptAllOutboundHttp: vi.fn().mockResolvedValue(undefined),
      getTcpPort: vi.fn(() => ({ fetch: tcpPortFetch })),
    },
  };

  return { ctx, start, tcpPortFetch, containerState };
}

describe('Container concurrent-start race (issue #173)', () => {
  test('two concurrent containerFetch calls do NOT both invoke start()', async () => {
    const { ctx, start } = makeMockCtx();

    // @ts-ignore - test-only construction
    const container: Container = new Container(ctx, {});
    (container as any).ctx = ctx;
    container.defaultPort = 8080;

    const reqA = new Request('https://example.com/a');
    const reqB = new Request('https://example.com/b');

    // Fire both concurrently. Both will:
    //   1. await this.state.getState()  -> microtask yield
    //   2. observe container.running === false
    //   3. enter startContainerIfNotRunning
    //   4. await this.state.setRunning()  -> microtask yield
    //   5. await this.scheduleNextAlarm() -> microtask yield
    //   6. call this.container.start(...) synchronously
    //
    // The second caller to reach step 6 sees running === true (set by the
    // first caller) and the workerd guard throws.
    const [resA, resB] = await Promise.all([
      // @ts-ignore - protected method
      container.containerFetch(reqA),
      // @ts-ignore - protected method
      container.containerFetch(reqB),
    ]);

    const startCallCount = start.mock.calls.length;
    const bodies = await Promise.all(
      [resA, resB].map(async r => {
        try {
          return typeof (r as Response).text === 'function' ? await (r as Response).text() : '';
        } catch {
          return '';
        }
      })
    );

    // Helpful diagnostic dump.
    // eslint-disable-next-line no-console
    console.log(
      '[repro] start call count:',
      startCallCount,
      'statuses:',
      resA.status,
      resB.status,
      'bodies:',
      bodies
    );

    // PRIMARY ASSERTION: container.start() must only ever be invoked once
    // when two requests race the readiness path. Today this fails (count: 2).
    expect(startCallCount).toBe(1);

    // SECONDARY ASSERTION: no response should surface the workerd
    // "already running" error string. Today this also fails: one response
    // is a 500 with body "Failed to start container: start() cannot be
    // called on a container that is already running."
    for (const body of bodies) {
      expect(body).not.toContain(
        'start() cannot be called on a container that is already running.'
      );
    }
  });
});
