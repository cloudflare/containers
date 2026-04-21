---
'@cloudflare/containers': minor
---

Add user-defined readiness checks via a `readyOn` class attribute and `addReadinessCheck` / `setReadinessChecks` instance methods. Ships with `portResponding(port)` and `isHealthy(path, port?)` helpers; arbitrary async checks are supported via `(container) => Promise<unknown>`.

`portResponding` checks for `defaultPort` and every entry in `requiredPorts` are added automatically, so you don't need to list them explicitly when declaring `readyOn`. `addReadinessCheck` preserves the auto port checks; `setReadinessChecks` replaces everything (include port checks explicitly if you need them).
