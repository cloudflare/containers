---
'@cloudflare/containers': patch
---

Ensure pending stop events are processed when the persisted container lifecycle state is still `running` but the underlying container has already exited.

Migrate the root unit test suite from Jest to Vitest and add a `test:unit` script for running `src/tests` directly.
