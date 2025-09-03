# Containers

A class for interacting with Containers on Cloudflare Workers.

## Features

- HTTP request proxying and WebSocket forwarding
- Simple container lifecycle management (starting and stopping containers)
- Event hooks for container lifecycle events (onStart, onStop, onError)
- Configurable sleep timeout that renews on requests
- Load balancing utilities

## Installation

```bash
npm install @cloudflare/containers
```

## Basic Example

```typescript
import { Container, getRandom } from '@cloudflare/containers';

export class MyContainer extends Container {
  // Configure default port for the container
  defaultPort = 8080;
  sleepAfter = '1m';
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;

    // If you want to route requests to a specific container,
    // pass a unique container identifier to .get()

    if (pathname.startsWith('/specific/')) {
      // In this case, each unique pathname will spawn a new container
      let id = env.MY_CONTAINER.idFromName(pathname);
      let stub = env.MY_CONTAINER.get(id);
      return await stub.fetch(request);
    }

    // (Note: getRandom is a temporary method until built-in autoscaling an
    // load balancing are added)

    // If you want to route to one of many containers (in this case 5),
    // use the getRandom helper
    let container = await getRandom(env.MY_CONTAINER, 5);
    return await container.fetch(request);
  },
};
```

## API Reference

### `Container` Class

The `Container` class that extends a container-enbled Durable Object to provide additional container-specific functionality.

#### Properties

- `defaultPort?`: Optional default port to use when communicating with the container. If not set, you must specify port in `containerFetch` calls, or use `switchPort`.
- `requiredPorts?`: Array of ports that should be checked for availability during container startup. Used by startAndWaitForPorts when no specific ports are provided.
- `sleepAfter`: How long to keep the container alive without activity (format: number for seconds, or string like "5m", "30s", "1h")
- `env`: Environment variables to pass to the container (Record<string, string>)
- `entrypoint?`: Custom entrypoint to override container default (string[])
- `enableInternet`: Whether to enable internet access for the container (boolean, default: true)
- Lifecycle methods: `onStart`, `onStop`, `onError`, `onActivityExpired`

#### Constructor Options

```typescript
constructor(ctx: any, env: Env, options?: {
  defaultPort?: number;           // Override default port
  sleepAfter?: string | number;   // Override sleep timeout
  env?: Record<string, string>;   // Environment variables to pass to the container
  entrypoint?: string[];          // Custom entrypoint to override container default
  enableInternet?: boolean;       // Whether to enable internet access for the container
})
```

#### Methods

##### Lifecycle Methods

All lifecycle methods can be implemented as async if needed.

- `onStart()`: Called when container starts successfully - override to add custom behavior
- `onStop()`: Called when container shuts down - override to add custom behavior
- `onError(error)`: Called when container encounters an error - override to add custom behavior
- `onActivityExpired()`: Called when the activity is expired - override to add custom behavior, like communicating with the container to see if it should be shutdown.

By default, it calls `ctx.container.destroy()`.
If you don't stop the container here, the activity tracker will be renewed, and this lifecycle hook will be called again when the timer re-expires.

##### Container Methods

- `fetch(request)`: Default handler to forward HTTP requests to the container. Can be overridden.
- `containerFetch(...)`: Sends an HTTP request to the container. Supports both standard fetch API signatures:

  - `containerFetch(request, port?)`: Traditional signature with Request object
  - `containerFetch(url, init?, port?)`: Standard fetch-like signature with URL string/object and RequestInit options
    Either port parameter or defaultPort must be specified.
    When you call any of the fetch functions, the activity will be automatically renewed, and if the container will be started if not already running.
    \*\*Do not use 'containerFetch' when trying to send a Request object with a websocket, until [this issue is addressed](https://github.com/cloudflare/workerd/issues/2319).
    You can overcome this limitation by doing:
    `container.fetch(switchPort(request, port))`

- `startAndWaitForPorts(args: StartAndWaitForPortsOptions): Promise<void>`

  Starts the container and then waits for specified ports to be ready. Prioritises `ports` passed in to the function, then `requiredPorts` if set, then `defaultPort`.

  ```typescript
  export interface StartAndWaitForPortsOptions {
    startOptions?: {
      /** Environment variables to pass to the container */
      envVars?: Record<string, string>;
      /** Custom entrypoint to override container default */
      entrypoint?: string[];
      /** Whether to enable internet access for the container */
      enableInternet?: boolean;
    };
    /** Ports to check */
    ports?: number | number[];
    cancellationOptions?: {
      /** Abort signal to cancel start and port checking */
      abort?: AbortSignal;
      /** Max time to wait for container to start, in milliseconds */
      instanceGetTimeoutMS?: number;
      /** Max time to wait for ports to be ready, in milliseconds */
      portReadyTimeoutMS?: number;
      /** Polling interval for checking container has started or ports are ready, in milliseconds */
      waitInterval?: number;
    };
  }
  ```

- `start()`: Starts the container if it's not running and sets up monitoring, without waiting for any ports to be ready.
- `stop(signal = SIGTERM)`: Sends the specified signal to the container.
- `destroy()`: Forcefully destroys the container.
- `getState()`: Get the current container state.
- `renewActivityTimeout()`: Manually renews the container activity timeout (extends container lifetime).
- `stopDueToInactivity()`: Called automatically when the container times out due to inactivity.
- `alarm()`: Default alarm handler. It's in charge of renewing the container activity and keeping the durable object alive. You can override `alarm()`, but because its functionality is currently vital to managing the container lifecycle, we recommend calling `schedule` to schedule tasks instead.

### Utility Functions

- `getRandom(binding, instances?)`: Load balances requests across multiple container instances

## Examples

### HTTP Example with Lifecycle Hooks

```typescript
import { Container } from '@cloudflare/containers';

export class MyContainer extends Container {
  // Configure default port for the container
  defaultPort = 8080;

  // Set how long the container should stay active without requests
  // Supported formats: "10m" (minutes), "30s" (seconds), "1h" (hours), or a number (seconds)
  sleepAfter = '10m';

  // Lifecycle method called when container starts
  override onStart(): void {
    console.log('Container started!');
  }

  // Lifecycle method called when container shuts down
  override onStop(): void {
    console.log('Container stopped!');
    // you can also call startAndWaitForPorts() again
    //   this.startAndWaitForPorts();
  }

  // Lifecycle method called on errors
  override onError(error: unknown): any {
    console.error('Container error:', error);
    throw error;
  }

  // Lifecycle method when the container class considers the activity to be expired
  override onActivityExpired() {
    console.log('Container activity expired');
    await this.destroy();
  }

  // Custom method that will extend the container's lifetime
  async performBackgroundTask(): Promise<void> {
    // Do some work...

    // Renew the container's activity timeout
    await this.renewActivityTimeout();
    console.log('Container activity timeout extended');
  }

  // Handle incoming requests
  async fetch(request: Request): Promise<Response> {
    // Default implementation forwards requests to the container
    // This will automatically renew the activity timeout
    return await this.containerFetch(request);
  }

  // Additional methods can be implemented as needed
}
```

### WebSocket Support

The Container class automatically supports proxying WebSocket connections to your container. WebSocket connections are bi-directionally proxied, with messages forwarded in both directions. The Container also automatically renews the activity timeout when WebSocket messages are sent or received.

You can call the `containerFetch` method directly to establish WebSocket connections:

```typescript
// Connect to a WebSocket on port 9000
const response = await container.containerFetch(request, 9000);
```

By default `fetch` also will do this by calling `containerFetch`.

### Container Configuration Example

You can configure how the container starts by setting the instance properties for environment variables, entrypoint, and network access:

```typescript
import { Container } from '@cloudflare/containers';

export class ConfiguredContainer extends Container {
  // Default port for the container
  defaultPort = 9000;

  // Set the timeout for sleeping the container after inactivity
  sleepAfter = '2h';

  // Environment variables to pass to the container
  envVars = {
    NODE_ENV: 'production',
    LOG_LEVEL: 'info',
    APP_PORT: '9000',
  };

  // Custom entrypoint to run in the container
  entrypoint = ['node', 'server.js', '--config', 'production.json'];

  // Enable internet access for the container
  enableInternet = true;

  // These configuration properties will be used automatically
  // when the container starts
}
```

### Multiple Ports and Custom Routing

You can create a container that doesn't use a default port and instead routes traffic to different ports based on request path or other factors:

```typescript
import { Container } from '@cloudflare/containers';

export class MultiPortContainer extends Container {
  // No defaultPort defined - we'll handle port specification manually

  constructor(ctx: any, env: any) {
    super(ctx, env);
  }

  /**
   * Process an incoming request and route to different ports based on path
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith('/api')) {
        // API server runs on port 3000
        return await this.containerFetch(request, 3000);
      } else if (url.pathname.startsWith('/admin')) {
        // Admin interface runs on port 8080
        return await this.containerFetch(request, 8080);
      } else {
        // Public website runs on port 80
        return await this.containerFetch(request, 80);
      }
    } catch (error) {
      return new Response(`Error: ${error instanceof Error ? error.message : String(error)}`, {
        status: 500,
      });
    }
  }
}
```

### Using Standard Fetch API Syntax

You can use the containerFetch method with standard fetch API syntax:

```typescript
import { Container } from '@cloudflare/containers';

export class FetchStyleContainer extends Container {
  defaultPort = 8080;

  async customHandler(): Promise<Response> {
    try {
      // Using the new fetch-style syntax
      const response = await this.containerFetch('/api/data', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: 'example' }),
      });

      // You can also specify a port with this syntax
      const adminResponse = await this.containerFetch(
        'https://example.com/admin',
        { method: 'GET' },
        3000 // port
      );

      return response;
    } catch (error) {
      return new Response(`Error: ${error instanceof Error ? error.message : String(error)}`, {
        status: 500,
      });
    }
  }
}
```

### Managing Container Idle Timeout

The Container class includes an automatic idle timeout feature that will shut down the container after a period of inactivity. This helps save resources when containers are not in use.

```typescript
import { Container } from '@cloudflare/containers';

export class TimeoutContainer extends Container {
  // Configure default port for the container
  defaultPort = 8080;

  // Set timeout to 30 minutes of inactivity
  sleepAfter = '30m'; // Supports "30s", "5m", "1h" formats, or a number in seconds

  // Custom method that will extend the container's lifetime
  async performBackgroundTask(data: any): Promise<void> {
    console.log('Performing background task...');

    // Manually renew the activity timeout, even though
    // you have not made a request to the container
    await this.renewActivityTimeout();

    console.log('Container activity timeout renewed');
  }

  // Activity timeout is automatically renewed on fetch requests
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Example endpoint to trigger background task
    if (url.pathname === '/task') {
      await this.performBackgroundTask();

      return new Response(
        JSON.stringify({
          success: true,
          message: 'Background task executed',
          nextStop: `Container will shut down after ${this.sleepAfter} of inactivity`,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // For all other requests, forward to the container
    // This will automatically renew the activity timeout
    return this.containerFetch(request);
  }
}
```

### Using Load Balancing

This package includes a `getRandom` helper which routes requests to one of N instances.
In the future, this will be automatically handled with smart by Cloudflare Containers
with autoscaling set to true, but is not yet implemented.

```typescript
import { Container, getContainer, getRandom } from '@cloudflare/containers';

export class MyContainer extends Container {
  defaultPort = 8080;
}

export default {
  async fetch(request: Request, env: any) {
    const url = new URL(request.url);

    // Example: Load balance across 5 container instances
    if (url.pathname === '/api') {
      const containerInstance = await getRandom(env.MY_CONTAINER, 5);
      return containerInstance.fetch(request);
    }

    // Example: Direct request to a specific container
    if (url.pathname.startsWith('/specific/')) {
      const id = url.pathname.split('/')[2] || 'default';
      const containerInstance = getContainer(env.MY_CONTAINER, id);
      return containerInstance.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
```

### Using getContainer

This package includes a `getContainer` helper which returns a container instance
stub.

The first argument is the Container's Durable Object namespace. The second argument is
optional and is a "name" for the Durable Object. This will be used to generate an ID,
then return a specific Container instance (Durable Object instance). If no second argument
is given, the name "cf-singleton-container" is used.
