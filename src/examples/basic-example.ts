import { Container } from '../lib/container';

/**
 * Example implementation of a Container class
 */
export class MyContainer extends Container {
  // Configure default port for the container - required for automatic proxying
  defaultPort = 8080;

  // Set how long the container should stay active without requests
  sleepAfter = "10m";

  constructor(ctx: any, env: any) {
    super(ctx, env, {
      // Container configuration - these are the same settings used when calling this.ctx.container.start()
      envVars: {
        NODE_ENV: "production",
        LOG_LEVEL: "info"
      },
      entrypoint: ["node", "server.js"],
      enableInternet: true
    });
  }

  // Lifecycle method called when container starts
  override onStart(): void {
    console.log('Container started!');
  }

  // Lifecycle method called when container shuts down
  override onStop(): void {
    console.log('Container stopped!');
  }

  // Lifecycle method called on errors
  override onError(error: unknown): any {
    console.error('Container error:', error);
    throw error;
  }

  // Handle incoming requests
  async fetch(request: Request): Promise<Response> {
    // Default implementation proxies requests to the container
    return this.containerFetch(request);
  }

  // Additional custom methods can be implemented as needed
}
