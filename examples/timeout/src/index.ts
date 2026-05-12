import { Container, getContainer } from '@cloudflare/containers';

/**
 * Example Container with a long inactivity timeout and a custom method
 * that manually extends the timeout when background work happens.
 */
export class TimeoutContainer extends Container {
  defaultPort = 8080;

  // Sleep the container after 30 minutes of inactivity. Supports "30s",
  // "5m", "1h" formats, or a number in seconds.
  sleepAfter = '30m';

  envVars = {
    MESSAGE: 'Timeout example container',
  };

  override onStart() {
    console.log('Container started with sleepAfter =', this.sleepAfter);
  }

  override onStop() {
    console.log('Container stopped.');
  }

  /**
   * Custom method that performs background work and manually renews the
   * activity timeout. This is useful when work is happening inside the
   * Durable Object that isn't a `fetch()` to the container (fetches
   * automatically renew the timeout).
   */
  async performBackgroundTask(data: unknown): Promise<void> {
    console.log('Performing background task with data:', data);
    this.renewActivityTimeout();
    console.log('Background task completed, activity timeout renewed');
  }
}

export default {
  async fetch(
    request: Request,
    env: { TIMEOUT_CONTAINER: DurableObjectNamespace<TimeoutContainer> }
  ): Promise<Response> {
    const url = new URL(request.url);
    const container = getContainer(env.TIMEOUT_CONTAINER, 'timeout-demo');

    // Trigger a background task on the DO that renews the inactivity timer
    // without going through the container's HTTP server.
    if (url.pathname === '/task') {
      await container.performBackgroundTask({ id: Date.now().toString(), type: 'manual' });
      return Response.json({
        success: true,
        message: 'Background task executed',
        note: 'Container inactivity timer was manually renewed.',
      });
    }

    // Show the current configured sleepAfter value.
    if (url.pathname === '/timeout-status') {
      // The class has `sleepAfter = '30m'` as a static default.
      return Response.json({ sleepAfter: '30m' });
    }

    // All other requests are proxied to the container. fetch() automatically
    // renews the activity timeout for each request.
    if (url.pathname.startsWith('/container')) {
      return container.fetch(request);
    }

    return new Response(
      [
        'Timeout example.',
        '  GET /container      -> proxies to the container',
        '  GET /task           -> runs a background task and renews the timeout',
        '  GET /timeout-status -> returns the configured sleepAfter value',
      ].join('\n')
    );
  },
};
