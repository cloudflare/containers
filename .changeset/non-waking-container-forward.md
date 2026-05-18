---
"@cloudflare/containers": patch
---

Add a non-starting `fetchIfRunning()` helper that only proxies requests to already-running, healthy containers without waking stopped containers.
