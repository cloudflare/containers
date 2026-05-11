---
'@cloudflare/containers': patch
---

Fix a race in `Container` where concurrent `container.fetch` calls to a cold container could throw `"start() cannot be called on a container that is already running."`.
