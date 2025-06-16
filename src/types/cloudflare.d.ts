import { type DurableObject } from 'cloudflare:workers';

/**
 * Type declarations for Cloudflare Workers
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