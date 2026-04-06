---
'@cloudflare/containers': patch
---

Fix `containerFetch()` throwing on proxied bodyless responses by skipping response reconstruction when `Response.body` is `null`.
