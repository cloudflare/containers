import { Container } from '../lib/container';

/**
 * Example implementation of a Container without a default port,
 * demonstrating how to manually specify ports for proxying
 */
export class NoDefaultPortContainer extends Container {
  // No defaultPort defined - we'll handle port specification manually

  // Configure normal timeout
  sleepAfter = "10m";

  constructor(ctx: any, env: any) {
    super(ctx, env);
  }

  /**
   * Process an incoming request and route to different ports based on path
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Different paths are handled by different services running on different ports
    try {
      if (url.pathname.startsWith('/api')) {
        // API server runs on port 3000
        return await this.containerFetch(request, 3000);
      }
      else if (url.pathname.startsWith('/admin')) {
        // Admin interface runs on port 8080
        return await this.containerFetch(request, 8080);
      }
      else if (url.pathname.startsWith('/metrics')) {
        // Prometheus metrics exposed on port 9090
        return await this.containerFetch(request, 9090);
      }
      else {
        // Public website runs on port 80
        return await this.containerFetch(request, 80);
      }
    } catch (error) {
      return new Response(`Error processing request: ${error instanceof Error ? error.message : String(error)}`, {
        status: 500
      });
    }
  }

  // Lifecycle methods
  override onStart(): void {
    console.log('Container started without checking any default port');
  }

  override onStop(): void {
    console.log('Container stopped');
  }
}