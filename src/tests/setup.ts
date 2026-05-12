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
