import { Container } from '../lib/container';

jest.mock('node:async_hooks', () => ({
  AsyncLocalStorage: class MockAsyncLocalStorage {
    getStore() {
      return null;
    }
    run(_store: unknown, fn: Function) {
      return fn();
    }
  },
}));

function makeMockStorage() {
  let alarmTs: number | null = null;
  const kv = new Map<string, unknown>();
  const rows: Array<{ id: string; callback: string; payload: string; type: string; time: number }> = [];

  const sqlExec = jest.fn((query: string) => {
    if (/COUNT\(\*\)/i.test(query)) {
      return [{ count: rows.length }];
    }
    if (/SELECT \* FROM container_schedules/i.test(query)) {
      return rows.slice();
    }
    return [];
  });

  return {
    alarmTs: () => alarmTs,
    rowsRef: rows,
    resetAlarmState: () => {
      alarmTs = null;
    },
    storage: {
      setAlarm: jest.fn(async (ts: number) => {
        alarmTs = ts;
      }),
      // Yield a microtask before returning so concurrent scheduleNextAlarm
      // calls observe each other's setAlarm writes (approximates the DO
      // input gate's per-invocation serialization).
      getAlarm: jest.fn(async () => {
        await Promise.resolve();
        return alarmTs;
      }),
      deleteAlarm: jest.fn(async () => {
        alarmTs = null;
      }),
      sync: jest.fn(async () => undefined),
      put: jest.fn(async (k: string, v: unknown) => {
        kv.set(k, v);
      }),
      get: jest.fn(async (k: string) => kv.get(k)),
      kv: {
        get: jest.fn((k: string) => kv.get(k)),
        put: jest.fn((k: string, v: unknown) => {
          kv.set(k, v);
        }),
        delete: jest.fn((k: string) => kv.delete(k)),
      },
      sql: { exec: sqlExec },
    },
  };
}

function makeMockCtx(storage: ReturnType<typeof makeMockStorage>['storage'], running: boolean) {
  const stubFetcher = { fetch: jest.fn() } as unknown as Fetcher;
  return {
    storage,
    blockConcurrencyWhile: jest.fn(async (fn: Function) => fn()),
    container: {
      running,
      start: jest.fn(),
      destroy: jest.fn(),
      signal: jest.fn(),
      monitor: jest.fn().mockReturnValue(Promise.resolve()),
      getTcpPort: jest.fn().mockReturnValue({
        fetch: jest.fn().mockResolvedValue({ status: 200, body: 'ok' }),
      }),
      interceptOutboundHttp: jest.fn().mockResolvedValue(undefined),
      interceptOutboundHttps: jest.fn().mockResolvedValue(undefined),
      removeInterceptOutbound: jest.fn().mockResolvedValue(undefined),
    },
    id: { toString: () => 'test-id' },
    // Required by applyOutboundInterception, which runs from the
    // constructor's blockConcurrencyWhile when container.running is true.
    exports: {
      ContainerProxy: jest.fn(() => stubFetcher),
    },
  };
}

/** Test subclass exposing the handful of private fields the tests need. */
class TestContainer extends Container {
  // Widen private `sleepAfterMs` for tests that need to force the
  // sleepAfter window to a near-future time.
  get sleepAfterMsField(): number {
    return (this as unknown as { sleepAfterMs: number }).sleepAfterMs;
  }
  set sleepAfterMsField(value: number) {
    (this as unknown as { sleepAfterMs: number }).sleepAfterMs = value;
  }
  // Widen private `inflightRequests` for tests simulating an open
  // WebSocket / streaming response without the full containerFetch path.
  get inflightRequestsField(): number {
    return (this as unknown as { inflightRequests: number }).inflightRequests;
  }
  set inflightRequestsField(value: number) {
    (this as unknown as { inflightRequests: number }).inflightRequests = value;
  }
}

async function makeContainer(opts: { running?: boolean } = {}) {
  const mock = makeMockStorage();
  const ctx = makeMockCtx(mock.storage, opts.running ?? false);
  const container = new TestContainer(ctx as unknown as DurableObjectState, {} as never);
  container.defaultPort = 5555;
  container.sleepAfter = '1h';
  container.renewActivityTimeout();
  // Drain the constructor's blockConcurrencyWhile callback before tests
  // observe state, so initial scheduleNextAlarm + applyOutboundInterception
  // have settled.
  await container.applyOutboundInterceptionPromise;
  mock.resetAlarmState();
  jest.clearAllMocks();
  return { container, ctx, mock };
}

describe('scheduleNextAlarm', () => {
  test('sets the alarm when none exists', async () => {
    const { container, mock } = await makeContainer();

    await container.scheduleNextAlarm(1000);

    const stored = mock.alarmTs();
    expect(stored).not.toBeNull();
    expect(stored! - Date.now()).toBeGreaterThan(500);
    expect(stored! - Date.now()).toBeLessThan(1500);
  });

  test('is idempotent — a later request does not push out a sooner alarm', async () => {
    const { container, mock } = await makeContainer();

    await container.scheduleNextAlarm(1000);
    const first = mock.alarmTs()!;

    await container.scheduleNextAlarm(5000);
    const second = mock.alarmTs()!;

    expect(second).toBe(first);
  });

  test('advances the alarm when an earlier time is requested', async () => {
    const { container, mock } = await makeContainer();

    await container.scheduleNextAlarm(5000);
    const first = mock.alarmTs()!;

    await container.scheduleNextAlarm(500);
    const second = mock.alarmTs()!;

    expect(second).toBeLessThan(first);
  });

  test('clamps sub-floor requests to MIN_ALARM_REARM_MS', async () => {
    const { container, mock } = await makeContainer();

    await container.scheduleNextAlarm(0);
    const stored = mock.alarmTs()!;
    expect(stored - Date.now()).toBeGreaterThanOrEqual(50);
  });

  test('concurrent callers settle on the earliest requested time', async () => {
    const { container, mock } = await makeContainer();

    await Promise.all([
      container.scheduleNextAlarm(5000),
      container.scheduleNextAlarm(1000),
      container.scheduleNextAlarm(3000),
    ]);

    const stored = mock.alarmTs()!;
    expect(stored - Date.now()).toBeLessThan(2000);
  });
});

describe('alarm() handler', () => {
  test('re-arms for the default heartbeat when idle', async () => {
    const { container, mock } = await makeContainer({ running: true });

    await container.alarm();

    const next = mock.alarmTs()!;
    const delta = next - Date.now();
    expect(delta).toBeGreaterThan(1000);
    expect(delta).toBeLessThanOrEqual(3 * 60 * 1000);
  });

  test('never re-arms for a time in the past', async () => {
    const { container, mock } = await makeContainer({ running: true });

    await container.alarm();

    const next = mock.alarmTs()!;
    expect(next).toBeGreaterThanOrEqual(Date.now());
  });

  test('honors sleepAfterMs when sooner than the default heartbeat', async () => {
    const { container, mock } = await makeContainer({ running: true });
    container.sleepAfterMsField = Date.now() + 30_000;

    await container.alarm();

    const next = mock.alarmTs()!;
    const delta = next - Date.now();
    expect(delta).toBeGreaterThan(25_000);
    expect(delta).toBeLessThan(35_000);
  });

  test('deletes the alarm when the container is stopped and no schedules remain', async () => {
    const { container, mock } = await makeContainer();

    await container.alarm();

    expect(mock.storage.deleteAlarm).toHaveBeenCalled();
    expect(mock.alarmTs()).toBeNull();
  });

  test('re-arms to the next pending schedule when the container is stopped', async () => {
    const { container, mock } = await makeContainer();
    mock.rowsRef.push({
      id: 'abc',
      callback: 'noop',
      payload: '{}',
      type: 'scheduled',
      time: Math.floor((Date.now() + 10_000) / 1000),
    });

    await container.alarm();

    expect(mock.storage.deleteAlarm).not.toHaveBeenCalled();
    const next = mock.alarmTs()!;
    expect(next).toBeGreaterThan(Date.now() + 5_000);
  });

  test('scheduleNextAlarm during an in-progress alarm does not cause immediate re-fire on exit', async () => {
    const { container, mock } = await makeContainer({ running: true });

    const alarmPromise = container.alarm();
    await container.scheduleNextAlarm(1000);
    await alarmPromise;

    const next = mock.alarmTs()!;
    const delta = next - Date.now();
    expect(delta).toBeGreaterThan(500);
  });

  test('retry exhaustion does not set an immediate alarm', async () => {
    const { container, mock } = await makeContainer({ running: true });

    await container.alarm({ isRetry: true, retryCount: 10 });

    const next = mock.alarmTs()!;
    expect(next).not.toBeNull();
    expect(next - Date.now()).toBeGreaterThan(50);
  });
});

describe('scheduleNextAlarm + alarm cadence invariant', () => {
  test('repeated external callers cannot drive alarm to fire in the past', async () => {
    const { container, mock } = await makeContainer({ running: true });

    for (let i = 0; i < 20; i++) {
      await container.scheduleNextAlarm(1000);
      await container.alarm();
      const next = mock.alarmTs()!;
      expect(next).toBeGreaterThanOrEqual(Date.now());
    }
  });
});

// Regression coverage for cloudflare/containers#147: an open WebSocket
// (tracked via inflightRequests) must keep the container alive even
// after the sleepAfter window has elapsed.
describe('inflight request activity tracking', () => {
  test('inflightRequests > 0 prevents onActivityExpired and renews the sleepAfter window', async () => {
    const { container } = await makeContainer({ running: true });
    const onExpired = jest.spyOn(container, 'onActivityExpired');
    container.inflightRequestsField = 1;
    container.sleepAfterMsField = Date.now() - 1;

    await container.alarm();

    expect(onExpired).not.toHaveBeenCalled();
    // A fresh sleepAfter window should be at least most of `sleepAfter`
    // ahead (test fixture uses 1h).
    expect(container.sleepAfterMsField).toBeGreaterThan(Date.now() + 55 * 60 * 1000);
  });

  test('onActivityExpired fires once the counter drops to zero and sleepAfter is past', async () => {
    const { container } = await makeContainer({ running: true });
    const onExpired = jest.spyOn(container, 'onActivityExpired').mockResolvedValue(undefined);
    container.inflightRequestsField = 0;
    container.sleepAfterMsField = Date.now() - 1;

    await container.alarm();

    expect(onExpired).toHaveBeenCalledTimes(1);
  });
});
