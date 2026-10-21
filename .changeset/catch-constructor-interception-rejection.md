---
'@cloudflare/containers': patch
---

Log outbound interception failures that happen while a running container is re-attached in the constructor, instead of leaving an unhandled promise rejection.
