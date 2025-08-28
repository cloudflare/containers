---
'@cloudflare/containers': patch
---

Add `startOptions` to `startAndWaitForPorts()`

This lets you configure env vars, the entrypoint command, and internet access when you call `startAndWaitForPorts`. Previously this was only supported on `start`.
