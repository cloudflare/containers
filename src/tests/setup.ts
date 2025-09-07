// Jest setup for Cloudflare Workers environment
import '@types/jest';

// Global mocks for Node.js process
global.process = global.process || {
  env: {}
};

// Mock console for cleaner test output  
const originalConsole = console;
global.console = {
  ...originalConsole,
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

// Reset console after each test
afterEach(() => {
  jest.clearAllMocks();
});
