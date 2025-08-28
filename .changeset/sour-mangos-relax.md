---
'@cloudflare/containers': patch
---

fix: use default port by default when making fetch requests to containers. this was breaking local dev as we would check the port of the host url, rather than the port the container was listening on. this was not an issue in production, as all ports are exposed there.
