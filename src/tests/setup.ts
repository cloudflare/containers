// Jest setup for Cloudflare Workers environment

// Global mocks for Node.js process
global.process = global.process || {
  env: {}
};

// Mock console for cleaner test output  
const originalConsole = console;
global.console = {
  ...originalConsole,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
};
