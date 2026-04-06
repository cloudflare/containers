/**
 * Mock implementation of the partyserver module for testing
 */

export class MockWebSocket {
  eventListeners: Record<string, any[]> = {
    message: [],
    close: [],
    error: [],
  };

  accept = jest.fn();
  send = jest.fn();
  close = jest.fn();

  addEventListener(type: string, handler: Function) {
    this.eventListeners[type].push(handler);
  }

  // Helper to simulate messages
  simulateMessage(data: string | ArrayBuffer) {
    this.eventListeners.message.forEach(handler => handler({ data }));
  }

  // Helper to simulate close
  simulateClose(code = 1000, reason = '') {
    this.eventListeners.close.forEach(handler => handler({ code, reason }));
  }

  // Helper to simulate error
  simulateError(error = {}) {
    this.eventListeners.error.forEach(handler => handler(error));
  }
}

export class Server {
  ctx: any;
  env: any;

  schedule = jest.fn().mockResolvedValue({ taskId: 'mock-task-id' });
  unschedule = jest.fn().mockResolvedValue(undefined);

  constructor(ctx: any, env: any) {
    this.ctx = ctx;
    this.env = env;
  }

  broadcast() {}
}

export interface Connection {
  id: string;
  ready: boolean;
  send(message: string | ArrayBufferLike): void;
  close(code?: number, reason?: string): void;
}

export interface WebSocket {
  accept(): void;
  send(message: string | ArrayBufferLike): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, handler: Function): void;
}

export type WebSocketPair = [WebSocket, WebSocket];

// Mock WebSocketPair factory function
export function WebSocketPair(): WebSocketPair {
  const client = new MockWebSocket();
  const server = new MockWebSocket();
  return [client as unknown as WebSocket, server as unknown as WebSocket];
}

export interface ConnectionContext {
  request: Request;
  url: URL;
  connectionId: string;
}
