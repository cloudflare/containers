import { vi } from 'vitest';

vi.mock('cloudflare:workers', () => {
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
});

// The runtime's `IdentityTransformStream` is a native byte pipe with no equivalent in Node. A
// `TransformStream` gives the tests the same shape: a writable the pump feeds and a readable the
// caller consumes, with backpressure once nobody reads. It copies each chunk on write, as the
// real one does, because once a write settles the pump hands its buffer to the next read, and
// that read detaches the buffer from any view the stream still holds.
if (!('IdentityTransformStream' in globalThis)) {
  vi.stubGlobal(
    'IdentityTransformStream',
    class IdentityTransformStream extends TransformStream<Uint8Array, Uint8Array> {
      constructor() {
        super({
          transform(chunk, controller) {
            controller.enqueue(chunk.slice());
          },
        });
      }
    }
  );
}
