---
'@cloudflare/containers': patch
---

Prevent an alarm racing with container startup from reporting the running container as stopped or removing its lifecycle alarm. `getState()` now also repairs stale stopped state when the runtime reports that the container is running.
