---
'@cloudflare/containers': patch
---

Preserve Cloudchamber startup rate-limit errors in the Containers helper and return HTTP 429 from `containerFetch()` when startup is rate limited.
