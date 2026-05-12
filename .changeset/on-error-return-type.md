---
'@cloudflare/containers': patch
---

Tighten the return type of `Container#onError` from `any` to `unknown`. Subclasses that override `onError` can still return any value. This should be a no-op for most users.
