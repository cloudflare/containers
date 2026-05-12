# AGENTS.md

Guidelines for AI agents working on the `@cloudflare/containers` package.

## Project Overview

This is the `@cloudflare/containers` npm package — a TypeScript library that wraps Cloudflare's container-enabled Durable Objects. It provides lifecycle management, HTTP/WebSocket proxying, outbound interception, scheduling, and load balancing utilities on top of the Cloudflare Workers runtime.

**Key exports** (`src/index.ts`):

- `Container` — base class, extends `DurableObject`
- `ContainerProxy` — `WorkerEntrypoint` used for outbound HTTP interception
- `outboundParams` — helper for typed outbound handler params
- `getRandom`, `loadBalance` (deprecated), `getContainer`, `switchPort` — utility functions

## Releasing
Add a new file to the `.changeset` directory representing a new version when wrapping up changes so they get released.
Do NOT change CHANGELOG.md, that is codegenerated on a release MR that is automated.

## Repository Layout

```
src/
  index.ts            # Public exports
  lib/
    container.ts      # Container + ContainerProxy class implementations
    helpers.ts        # generateId, parseTimeExpression
    utils.ts          # getRandom, getContainer, loadBalance, switchPort
  types/              # Shared TypeScript types
examples/             # Runnable example Workers using the package
```

Build output goes to `dist/`. Do not edit files in `dist/`.

## Core Concepts

### Container Class (`src/lib/container.ts`)

`Container` extends `DurableObject`. Each instance wraps exactly one container process via `ctx.container`.

**Key instance properties:**

- `defaultPort?: number` — port used by `fetch()` and `containerFetch()` when none is specified
- `requiredPorts?: number[]` — ports checked during `startAndWaitForPorts`
- `sleepAfter: string | number` — inactivity timeout before `onActivityExpired()` fires (default `"10m"`)
- `envVars`, `entrypoint`, `enableInternet` — container start config defaults
- `pingEndpoint: string` — endpoint polled to confirm container readiness (default `"ping"`)

**Important timeouts (constants in `container.ts`):**

- `TIMEOUT_TO_GET_CONTAINER_MS = 8_000` — time to get a container instance
- `TIMEOUT_TO_GET_PORTS_MS = 20_000` — time to wait for ports to be ready
- `INSTANCE_POLL_INTERVAL_MS = 300` — polling interval
- `MAX_ALARM_RETRIES = 3` — max alarm retries before scheduling next

**Lifecycle hooks (override in subclasses):**

- `onStart()` — fired on `stopped → running → healthy` transitions
- `onStop(params)` — fired when container shuts down
- `onError(error)` — fired on errors; default logs and rethrows
- `onActivityExpired()` — fired when `sleepAfter` timeout expires; default calls `this.stop()`

**Starting a container:**

- `start(startOptions?, waitOptions?)` — starts without waiting for ports
- `startAndWaitForPorts(args)` — starts and runs all readiness checks (defaults to port checks)
- `waitForPort(waitOptions)` — polls a single port; returns tries used
- `waitForPath(waitOptions & { path })` — polls an HTTP path until it returns 2xx

**Readiness checks:**

Readiness checks gate fetch proxying — every check must resolve before requests flow to the container. All checks run in parallel, so ordering doesn't matter.

Checks should retry internally on transient "not ready yet" conditions rather than rejecting. A rejection is terminal and causes the parent `fetch` to return a 500. Loop cooperatively against `options.signal` (which fires on timeout) and only reject when something is genuinely broken.

`portResponding` checks for `defaultPort` and every entry in `requiredPorts` are added automatically, so you don't need to list them explicitly:

```ts
import { Container, isHealthy } from '@cloudflare/containers';

class MyApp extends Container {
  defaultPort = 8080;
  // portResponding(8080) is added automatically
  readyOn = [isHealthy('/health')];
}
```

Add checks at runtime with `addReadinessCheck` — auto port checks are still applied:

```ts
// Effective: [portResponding(8080), isHealthy('/ready')]
container.addReadinessCheck(isHealthy('/ready'));

container.addReadinessCheck(async () => {
  await warmCachesFromR2();
});
```

`setReadinessChecks` takes full control: auto port checks are NOT added, so include them explicitly if you need them. Pass `[]` to opt out entirely.

```ts
import { portResponding, isHealthy } from '@cloudflare/containers';

// Replace everything — include port checks explicitly
container.setReadinessChecks([
  portResponding(8080),
  isHealthy('/ready'),
  async () => { await migrateDatabase(); },
]);

// Opt out — ready as soon as the process starts
container.setReadinessChecks([]);
```

**HTTP methods:**

- `fetch(request)` — forwards HTTP + WebSocket; uses `defaultPort` or `cf-container-target-port` header
- `containerFetch(requestOrUrl, portOrInit?, port?)` — HTTP only (no WebSocket); flexible signatures

**Utility methods:**

- `stop(signal?)` — sends signal (default `SIGTERM`)
- `destroy()` — sends `SIGKILL`
- `getState()` — returns current `State`
- `renewActivityTimeout()` — resets the inactivity timer
- `schedule(when, callback, payload?)` — schedules a future callback via DO alarms

### Outbound Interception

`ContainerProxy` (`WorkerEntrypoint`) handles outbound HTTP from the container. It must be exported from the Worker entrypoint alongside `Container` subclasses.

Handler priority (highest to lowest):

1. Runtime `setOutboundByHost` override
2. Static `outboundByHost`
3. Runtime `setOutboundHandler` catch-all
4. Static `outbound`
5. Direct internet (if `enableInternet = true`)

Static configuration (set on the class):

```ts
static outboundByHost = { 'example.com': handler }
static outbound = catchAllHandler
static outboundHandlers = { myHandler: handler }
```

Runtime configuration (call on instance):

```ts
await this.setOutboundByHost('example.com', 'myHandler');
await this.setOutboundHandler('myHandler');
await this.removeOutboundByHost('example.com');
await this.setOutboundByHosts({ 'example.com': 'myHandler' });
```

### Scheduling

Use `this.schedule()` instead of overriding `alarm()`. The alarm handler manages container lifecycle internally. Scheduled callbacks must be method names on the class.

```ts
await this.schedule(30, 'myCallback', { data: 'payload' }); // 30s delay
await this.schedule(new Date('2026-01-01'), 'myCallback'); // specific time
```

### Utility Functions (`src/lib/utils.ts`)

- `getRandom(binding, n?)` — picks one of `n` instances (default 3) by random name
- `getContainer(binding, name?)` — gets a named instance (default `"cf-singleton-container"`)
- `switchPort(request, port)` — sets `cf-container-target-port` header; use with `fetch()` for WebSocket support
- `loadBalance` — deprecated alias for `getRandom`

## Development

```bash
npm run build       # tsc compile to dist/
npm run typecheck   # type check without emitting
npm run lint        # eslint
npm run format      # prettier
npm run test        # runs tests in each examples/*/test directory
```

Tests live inside `examples/*/test/`. There are no unit tests directly in `src/`. When adding new functionality, check whether the relevant example covers it and add a test there.

## Common Patterns

**Always set `defaultPort`** in subclasses unless you're doing manual port routing.

**WebSocket forwarding** requires `fetch()` + `switchPort()`, not `containerFetch()`.

**Outbound interception** requires exporting `ContainerProxy` from the Worker entrypoint:

```ts
export { ContainerProxy } from '@cloudflare/containers';
```

**Do not override `alarm()`**. Use `schedule()` instead; the internal alarm handler manages container activity timers.

**Error states:** Container state transitions are `stopped → running → healthy → stopping → stopped`. The `stopped_with_code` status carries an exit code.

## Changeset

This repo uses [changesets](https://github.com/changesets/changesets). When making a user-facing change, add a changeset:

```bash
npx changeset
```

