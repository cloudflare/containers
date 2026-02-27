---
'@cloudflare/containers': patch
---

Fix container startup failures during local Docker development

Containers that took longer than expected to start (common on Docker Desktop) would fail permanently instead of retrying.
