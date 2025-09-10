# Basic Container Fixture

Tests basic container functionality including:

- HTTP request forwarding via `container.fetch()` and `container.containerFetch()`
- Container lifecycle methods (`onStart`, `onStop`, `onError`)
- Container state management and port configuration
- Different container startup patterns (`start` vs `startAndWaitForPorts`)

## Usage

```bash
npm install
npm run dev
npm test
```

## Endpoints

- `/fetch` - Forward requests via `container.fetch()`
- `/containerFetch` - Forward requests via `container.containerFetch()`
- `/start` - Start container without waiting for ports
- `/startAndWaitForPorts` - Start container and wait for ports to be ready
- `/status` - Get container state
- `/stop` - Stop container