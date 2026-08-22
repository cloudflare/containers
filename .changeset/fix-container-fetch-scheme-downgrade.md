---
'@cloudflare/containers': patch
---

Fix `containerFetch` rewriting `https:` inside query strings and fragments. The scheme downgrade
applied to container requests used an unanchored string replace, so a URL that was already
`http:` had the first `https:` in its query or fragment downgraded instead of its scheme —
corrupting parameters that carry an absolute URL, such as `/callback?redirect=https://app.example.com`.
