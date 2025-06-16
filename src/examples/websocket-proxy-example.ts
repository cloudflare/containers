import { Container } from '../lib/container';

/**
 * Example implementation of a Container with WebSocket proxying
 * Supports both HTTP and WebSocket traffic to the container
 */
export class WebSocketProxyContainer extends Container {
  // Configure default port for the container
  defaultPort = 8080;

  // Set how long the container should stay active without activity
  sleepAfter = "15m";

  constructor(ctx: any, env: any) {
    super(ctx, env, {
      // Container environment variables
      envVars: {
        NODE_ENV: "production",
        ENABLE_WEBSOCKETS: "true"
      },
      // Start a Node.js WebSocket server in the container
      entrypoint: ["node", "server.js"],
      enableInternet: true
    });
  }

  // Lifecycle methods
  override onStart(): void {
    console.log('Container started with WebSocket support');
  }

  override onStop(): void {
    console.log('Container stopped');
  }

  override onError(error: unknown): any {
    console.error('Container error:', error);
    throw error;
  }

  /**
   * Custom fetch implementation to handle both HTTP and WebSocket requests
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Check if this is a WebSocket upgrade request
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      // Proxy WebSocket to the container
      // This automatically renews the activity timeout on each message
      return this.containerFetch(request, this.defaultPort);
    }

    // Handle special endpoint to check stats
    if (url.pathname === '/stats') {
      return new Response(JSON.stringify({
        status: 'ok',
        port: this.defaultPort,
        sleepAfter: this.sleepAfter
      }, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // For regular HTTP requests, use standard proxying
    return await this.containerFetch(request, this.defaultPort);
  }
}