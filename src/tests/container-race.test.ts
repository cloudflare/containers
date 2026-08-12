// Reproduction for https://github.com/cloudflare/containers/issues/173
//
// The error "start() cannot be called on a container that is already running."
// is thrown by workerd's Container::start() at src/workerd/api/container.c++:209
// via JSG_REQUIRE(!running, ...). It guards against the JS-visible `running`
// flag being true.
//
// The original race in @cloudflare/containers happened because the readiness
// path had multiple `await` points before the synchronous
// `this.container.start(...)` call. Each `await` yielded the DO input gate,
// allowing two concurrent fetches to both pass the `if (this.container.running)
// return 0;` early exit. Whichever called start() second hit the workerd
// JSG_REQUIRE.
//
// This test reproduces the race deterministically: it relies on the
// natural microtask scheduling that `Promise.all([fetchA, fetchB])`
// produces, with mocked storage that yields a microtask on every
// operation (the same shape real DO storage has).

import { describe, expect } from 'vitest';
import { test } from './fixtures';

describe('Container concurrent-start race (issue #173)', () => {
  test('two concurrent containerFetch calls do NOT both invoke start()', async ({
    mockCtx,
    container,
  }) => {
    // Override the default `start` to mirror workerd's
    // src/workerd/api/container.c++:209 JSG_REQUIRE(!running, ...) guard:
    // calling start() while already running throws.
    mockCtx.container.start.mockImplementation(() => {
      if (mockCtx.container.running) {
        throw new Error('start() cannot be called on a container that is already running.');
      }
      mockCtx.container.running = true;
    });

    const reqA = new Request('https://example.com/a');
    const reqB = new Request('https://example.com/b');

    // Fire both concurrently. Both callers enter the readiness path, but the
    // in-flight start guard makes the second caller join the first start
    // attempt instead of calling `this.container.start(...)` itself.
    const [resA, resB] = await Promise.all([
      container.containerFetch(reqA),
      container.containerFetch(reqB),
    ]);

    const startCallCount = mockCtx.container.start.mock.calls.length;
    const bodies = await Promise.all(
      [resA, resB].map(async r => {
        try {
          return typeof r.text === 'function' ? await r.text() : '';
        } catch {
          return '';
        }
      })
    );

    // Helpful diagnostic dump.
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
