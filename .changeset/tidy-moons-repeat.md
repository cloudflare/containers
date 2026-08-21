---
'@cloudflare/containers': minor
---

Declare an optional peer dependency on `@cloudflare/workers-types` of `>=4.20260402.1`, the first release providing `Container.interceptOutboundHttps`.

Because consumers supply their own runtime types, the version this package builds against is the minimum they need. The range is enforced only when `@cloudflare/workers-types` is actually installed — projects using `wrangler types` are unaffected.
