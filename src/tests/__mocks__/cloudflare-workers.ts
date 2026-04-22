/**
 * Jest mock for the `cloudflare:workers` virtual module. Provides stub
 * implementations of DurableObject and WorkerEntrypoint good enough to
 * let Container / ContainerProxy class bodies compile and run under
 * Node + ts-jest without a real workerd runtime.
 */

export class DurableObject<Env = unknown> {
  ctx: unknown;
  env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkerEntrypoint<Env = unknown, _Props = unknown> {
  ctx: unknown;
  env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
