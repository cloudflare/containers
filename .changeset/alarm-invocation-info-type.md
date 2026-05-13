---
'@cloudflare/containers': patch
---

Use the canonical `AlarmInvocationInfo` type from `@cloudflare/workers-types` for the `alarm()` parameter instead of an inline type. This is a no-op for users (the shape is identical), but keeps the override aligned with the Durable Object base class signature.
