# @cloudflare/containers

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
