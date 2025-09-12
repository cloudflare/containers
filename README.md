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
import { Container, getContainer, getRandom } from '@cloudflare/containers';

export class MyContainer extends Container {
  // Configure default port for the container
  defaultPort = 8080;
  // After 1 minute of no new activity, shutdown the container
  sleepAfter = '1m';
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;

    // If you want to route requests to a specific container,
    // pass a unique container identifier to .get()

    if (pathname.startsWith('/specific/')) {
      // In this case, each unique pathname will spawn a new container
      const container = env.MY_CONTAINER.getByName(pathname);
      return await container.fetch(request);
    }

    // Note: this is a temporary method until built-in autoscaling and load balancing are added.
    // If you want to route to one of many containers (in this case 5), use the getRandom helper.
    // This load balances incoming requests across these container instances.
    let container = await getRandom(env.MY_CONTAINER, 5);
    return await container.fetch(request);
  },
};
```

## API Reference

### `Container` Class

The `Container` class that extends a container-enbled Durable Object to provide additional container-specific functionality.

#### Properties

- `defaultPort?`

  Optional default port to use when communicating with the container. If this is not set, or you want to target a specific port on your container, you can specify the port with `fetch(switchPort(req, 8080))` or `containerFetch(req, 8080)`.

- `requiredPorts?`

  Array of ports that should be checked for availability during container startup. Used by `startAndWaitForPorts` when no specific ports are provided.

- `sleepAfter`

  How long to keep the container alive without activity (format: number for seconds, or string like "5m", "30s", "1h").

  Defaults to "10m", meaning that after the Container class Durable Object receives no requests for 10 minutes, it will shut down the container.

The following properties are used to set defaults when starting the container, but can be overriden on a per-instance basis by passing in values to `startAndWaitForPorts()` or `start()`.

- `env?: Record<string, string>`

  Environment variables to pass to the container when starting up.

- `entrypoint?: string[]`

  Specify an entrypoint to override image default.

- `enableInternet: boolean`

  Whether to enable internet access for the container.

  Defaults to `true`.

#### Methods

##### Lifecycle Hooks

These lifecycle methods are automatically called when the container state transitions. Override these methods to use these hooks.

See [this example](#http-example-with-lifecycle-hooks).

- `onStart()`

  Called when container starts successfully.

  - called when states transition from `stopped` -> `running`, `running` -> `healthy`

- `onStop()`

  Called when container shuts down.

- `onError(error)`

  Called when container encounters an error, and by default logs and throws the error.

- `onActivityExpired()`

  Called when the activity is expired. The container will run continue to run for some time after the last activity - this length of time is configured by `sleepAfter`.
  By default, this stops the container with a `SIGTERM`, but you can override this behaviour, as with other lifecycle hooks. However, if you don't stop the container here, the activity tracker will be renewed, and this lifecycle hook will be called again when the timer re-expires.

##### Container Methods

- `fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>`

  Forwards HTTP requests to the container.

  If you want to target a specific port on the container, rather than the default port, you should use `switchPort` like so:

  ```typescript
  const container = env.MY_CONTAINER.getByName('id');
  await container.fetch(switchPort(request, 8080));
  ```

  Make sure you provide a port with switchPort or specify a port with the `defaultPort` property.

  You must use `fetch` rather than `containerFetch` if you want to forward websockets.

  Note that when you call any of the fetch functions, the activity will be automatically renewed (sleepAfter time starts after last activity), and the container will be started if not already running.

- `containerFetch(...)`

  Note: `containerFetch` does not work with websockets.

  Sends an HTTP request to the container. Supports both standard fetch API signatures:

  - `containerFetch(request, port?)`: Traditional signature with Request object
  - `containerFetch(url, init?, port?)`: Standard fetch-like signature with URL string/object and RequestInit options

- `startAndWaitForPorts(args: StartAndWaitForPortsOptions): Promise<void>`

  Starts the container and then waits for specified ports to be ready. Prioritises `ports` passed in to the function, then `requiredPorts` if set, then `defaultPort`.

  ```typescript
  interface StartAndWaitForPortsOptions {
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

- `start(startOptions?: ContainerStartConfigOptions, waitOptions?: WaitOptions)`

  Starts the container, without waiting for any ports to be ready.

  You might want to use this instead of `startAndWaitForPorts` if you want to:

  - Start a container without blocking until a port is available
  - Initialize a container that doesn't expose ports
  - Perform custom port availability checks separately

  Options:

  ```typescript
  interface ContainerStartConfigOptions {
    /** Environment variables to pass to the container */
    envVars?: Record<string, string>;
    /** Custom entrypoint to override container default */
    entrypoint?: string[];
    /** Whether to enable internet access for the container */
    enableInternet?: boolean;
  }

  interface WaitOptions {
    /** The port number to check for readiness */
    portToCheck: number;
    /** Optional AbortSignal, use this to abort waiting for ports */
    signal?: AbortSignal;
    /** Number of attempts to wait for port to be ready */
    retries?: number;
    /** Time to wait in between polling port for readiness, in milliseconds */
    waitInterval?: number;
  }
  ```

- `stop(signal = SIGTERM): Promise<void>`

  Sends the specified signal to the container. Triggers `onStop`.

- `destroy(): Promise<void>`

  Forcefully destroys the container (sends `SIGKILL`). Triggers `onStop`.

- `getState(): Promise<State>`

  Get the current container state.

  ```typescript
  type State = {
    lastChange: number;
  } & (
    | {
        // 'running' means that the container is trying to start and is transitioning to a healthy status.
        //           onStop might be triggered if there is an exit code, and it will transition to 'stopped'.
        status: 'running' | 'stopping' | 'stopped' | 'healthy';
      }
    | {
        status: 'stopped_with_code';
        exitCode?: number;
      }
  );
  ```

- `renewActivityTimeout()`

  Manually renews the container activity timeout (extends container lifetime).

- `schedule<T = string>(when: Date | number, callback: string, payload?: T): Promise<Schedule<T>>`

  Options:

  - `when`: When to execute the task (Date object or number of seconds delay)
  - `callback`: Name of the function to call as a string
  - `payload`: Data to pass to the callback

  Instead of using the default alarm handler, use `schedule()` instead. The default alarm handler is in charge of renewing the container activity and keeping the durable object alive. You can override `alarm()`, but because its functionality is currently vital to managing the container lifecycle, we recommend calling `schedule` to schedule tasks instead.

### Utility Functions

- `getRandom(binding, instances?: number)`

  Get a random container instances across N instances. This is useful for load balancing.
  Returns a stub for the container.
  See [example](#using-load-balancing).

- `getContainer(binding, name?: string)`
  Helper to get a particular container instance stub.

  e.g. `const container = getContainer(env.CONTAINER, "unique-id")`

  If no name is provided, "cf-singleton-container" is used.

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

  // Additional methods can be implemented as needed
}
```

### WebSocket Support

The Container class automatically supports proxying WebSocket connections to your container. WebSocket connections are bi-directionally proxied, with messages forwarded in both directions. The Container also automatically renews the activity timeout when WebSocket messages are sent or received.

```typescript
// Connect to a WebSocket on port 9000
const response = await container.fetch(switchPort(request, 9000));
```

Note websockets are not supported with `containerFetch`.

### Container Configuration Example

You can configure defaults for how the container starts by setting the instance properties for environment variables, entrypoint, and network access:

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

You can also set these on a per-instance basis with `start` or `startAnbdWaitForPorts`

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
