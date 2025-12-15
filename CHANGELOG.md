# @cloudflare/containers

## 0.0.31

### Patch Changes

- 32a0928: fix: correctly sync state when calling `stop()`

## 0.0.30

### Patch Changes

- 33faed8: calling `stop()` on a container that is not running should not send another stop signal

## 0.0.29

### Patch Changes

- e4879c8: Miscellaneous minor fixes and improvements to starting containers and port checking.

  - When calling `startAndWaitForPorts`, check for port-readiness even if the container is started.
  - Add `waitForPort()` method.
  - Add options to configure timeout and polling interval to `start`, similar to what `cancellationOptions` on `startAndWaitForPorts`. `start` does not check for port readiness but still polls for available and starting container.
  - Respect `waitInterval` if passed in via `start` or `startAndWaitForPorts` when polling container for readiness.

- 8458fda: fix racy condition where we would try and start containers that are running

## 0.0.28

### Patch Changes

- 1a6c6d9: add function overload to startAndWaitForPorts()

  You can now use `startAndWaitForPorts({startOptions: {envVars: {FOO:"BAR"}}})` instead of `startAndWaitForPorts(undefined, {},  {envVars: {FOO:"BAR"}})`, although that is still supported.

## 0.0.27

### Patch Changes

- 77da121: Add `startOptions` to `startAndWaitForPorts()`

  This lets you configure env vars, the entrypoint command, and internet access when you call `startAndWaitForPorts`. Previously this was only supported on `start`.

- f57250f: chore: add changesets to generate changelogs for @cloudflare/containers
- 5ad3877: fix: use default port by default when making fetch requests to containers. this was breaking local dev as we would check the port of the host url, rather than the port the container was listening on. this was not an issue in production, as all ports are exposed there.
