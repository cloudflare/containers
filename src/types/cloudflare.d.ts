import { type DurableObject } from 'cloudflare:workers';

/**
 * Type declarations for Cloudflare Workers and PartyKit types
 */

// Cloudflare Durable Object Types
declare interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  idFromString(id: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

declare interface DurableObjectId {
  toString(): string;
}

declare interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

// PartyKit Server Types
declare module 'partyserver' {
  export class Server<Env = unknown> {
    constructor(ctx: any, env: Env);
    get room(): string;
    broadcast(message: string | ArrayBufferLike, ignore?: string[]): void;

    // Scheduled task methods
    schedule(delaySeconds: number, methodName: string, data?: any): Promise<{ taskId: string }>;
    unschedule(taskId: string): Promise<void>;

    ctx: DurableObject['ctx'];
  }

  export interface WebSocket {
    accept(): void;
    send(message: string | ArrayBufferLike): void;
    close(code?: number, reason?: string): void;
    addEventListener(
      type: 'message',
      handler: (event: { data: string | ArrayBufferLike }) => void
    ): void;
    addEventListener(
      type: 'close',
      handler: (event: { code: number; reason: string }) => void
    ): void;
    addEventListener(type: 'error', handler: (event: any) => void): void;
  }

  export type WebSocketPair = [WebSocket, WebSocket];

  export function WebSocketPair(): WebSocketPair;

  export interface Connection {
    id: string;
    ready: boolean;
    send(message: string | ArrayBufferLike): void;
    close(code?: number, reason?: string): void;
  }

  export interface ConnectionContext {
    request: Request;
    url: URL;
    connectionId: string;
  }

  export interface Party {
    id: string;
    connections: Map<string, Connection>;
    onRequest(request: Request): Promise<Response>;
  }
}
