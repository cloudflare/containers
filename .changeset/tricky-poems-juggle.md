---
'@cloudflare/containers': patch
---

Miscellaneous minor fixes and improvements to starting containers and port checking.

- When calling `startAndWaitForPorts`, check for port-readiness even if the container is started.

- Add `waitForPort()` method.

- Add options to configure timeout and polling interval to `start`, similar to what `cancellationOptions` on `startAndWaitForPorts`. `start` does not check for port readiness but still polls for available and starting container.

- Respect `waitInterval` if passed in via `start` or `startAndWaitForPorts` when polling container for readiness.
