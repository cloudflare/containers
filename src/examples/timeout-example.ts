import { Container } from '../lib/container';

/**
 * Example implementation of a Container with custom timeout settings
 */
export class TimeoutContainer extends Container {
  // Configure default port for the container
  defaultPort = 8080;

  // Customize the sleep timeout to 30 minutes
  sleepAfter = "30m";

  constructor(ctx: any, env: any) {
    super(ctx, env);
  }

  // Lifecycle method called when container starts
  override onStart(): void {
    console.log('Container started with timeout set to:', this.sleepAfter);
  }

  // Lifecycle method called when container shuts down
  override onStop(): void {
    console.log('Container stopped.');
  }

  // Custom method that will renew the activity timeout
  async performBackgroundTask(data: any): Promise<void> {
    console.log('Performing background task with data:', data);

    // This will renew the activity timeout
    await this.renewActivityTimeout();

    console.log('Background task completed, activity timeout renewed');
  }

  // Handle incoming HTTP requests
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Example endpoint to trigger background task
    if (url.pathname === '/task') {
      const taskData = {
        id: Date.now().toString(),
        type: 'manual'
      };

      await this.performBackgroundTask(taskData);

      return new Response(JSON.stringify({
        success: true,
        message: 'Background task executed',
        nextStop: `Container will shut down after ${this.sleepAfter} of inactivity`
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Endpoint to view timeout status
    if (url.pathname === '/timeout-status') {
      return new Response(JSON.stringify({
        sleepAfter: this.sleepAfter
      }, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // For all other requests, proxy to the container
    // This will automatically renew the activity timeout
    return await this.containerFetch(request);
  }
}