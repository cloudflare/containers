// Mock for cloudflare:workers module
const DurableObject = class MockDurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
  
  fetch() {
    return new Response('Mock response');
  }
  
  async alarm() {
    // Mock alarm implementation
  }
};

// Mock ExecutionContext
const ExecutionContext = class MockExecutionContext {
  waitUntil() {}
  passThroughOnException() {}
};

module.exports = {
  DurableObject,
  ExecutionContext
};
