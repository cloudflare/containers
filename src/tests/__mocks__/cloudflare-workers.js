// Mock for cloudflare:workers module
class MockDurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    return new Response('Mock response');
  }
}

module.exports = {
  DurableObject: MockDurableObject
};
