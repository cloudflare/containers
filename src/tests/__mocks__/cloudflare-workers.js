// Mock for cloudflare:workers module
class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    return new Response('Mock DurableObject response');
  }
}

module.exports = { DurableObject };
