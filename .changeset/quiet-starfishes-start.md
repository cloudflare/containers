---
"@cloudflare/containers": minor
---

Defer start-path storage and alarm setup until after the container start call.

`onStart()` no longer runs under `blockConcurrencyWhile()`. Previously, `start()` and `startAndWaitForPorts()` queued incoming requests until `onStart()` completed. Now, awaits inside user-supplied `onStart()` handlers can yield the input gate, so other requests may be served before `onStart()` completes.

Runtime outbound configuration set with methods like `setOutboundByHost()`, `setOutboundHandler()`, `setAllowedHosts()`, and `setDeniedHosts()` is no longer persisted to Durable Object storage or restored after Durable Object hydration/container restart. New container starts use the class's static outbound configuration defaults until runtime configuration is set again.
