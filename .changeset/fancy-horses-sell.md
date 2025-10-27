---
'@cloudflare/containers': patch
---

calling `stop()` on a container that is not running should not send another stop signal
