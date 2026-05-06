// Jest setup file for containers tests
// This file configures the test environment for Cloudflare Workers

// Mock global fetch if needed
if (typeof global.fetch === 'undefined') {
  global.fetch = jest.fn();
}

// Mock Request and Response constructors if needed
if (typeof global.Request === 'undefined') {
  global.Request = class MockRequest {
    constructor(url: string, init?: RequestInit) {
      this.url = url;
      this.method = init?.method || 'GET';
      this.headers = new Headers(init?.headers);
      this.signal = init?.signal;
    }
    url: string;
    method: string;
    headers: Headers;
    signal?: AbortSignal;
  } as any;
}

if (typeof global.Response === 'undefined') {
  global.Response = class MockResponse {
    constructor(body?: any, init?: ResponseInit) {
      this.status = init?.status || 200;
      this.body = body;
    }
    status: number;
    body: any;
  } as any;
}

if (typeof global.Headers === 'undefined') {
  global.Headers = class MockHeaders extends Map {
    constructor(init?: HeadersInit) {
      super();
      if (init) {
        if (Array.isArray(init)) {
          init.forEach(([key, value]) => this.set(key, value));
        } else if (init instanceof Headers) {
          init.forEach((value, key) => this.set(key, value));
        } else {
          Object.entries(init).forEach(([key, value]) => this.set(key, value));
        }
      }
    }
    
    get(name: string): string | null {
      return super.get(name.toLowerCase()) || null;
    }
    
    set(name: string, value: string): void {
      super.set(name.toLowerCase(), value);
    }
    
    has(name: string): boolean {
      return super.has(name.toLowerCase());
    }
  } as any;
}
