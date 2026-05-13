---
'@cloudflare/containers': patch
---

Preserve original errors as `cause` when wrapping abort/timeout errors during container startup, making it easier to debug the underlying failure.
