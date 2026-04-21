---
'@cloudflare/containers': minor
---

Add user-defined readiness checks via a `readyOn` class attribute and `addReadinessCheck` / `setReadinessChecks` instance methods. Ships with `portResponding(port)` and `pathHealthy(path, port?)` helpers; arbitrary async checks are supported via `(container) => Promise<unknown>`. When `readyOn` is unset, the container falls back to the historical behaviour of waiting for `defaultPort` / `requiredPorts`.
