---
'@cloudflare/containers': patch
---

Fail with an actionable error when `interceptHttps` is enabled on a runtime that does not support `ctx.container.interceptOutboundHttps`.

This previously surfaced as a bare `TypeError: this.container.interceptOutboundHttps is not a function`. Worse, the failure happened part-way through applying interception, so a container could be left with HTTP hosts already intercepted. The support check now runs before any interception is applied, and the error names the runtime date required (2026-04-02 or later).
