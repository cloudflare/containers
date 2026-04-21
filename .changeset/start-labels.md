---
'@cloudflare/containers': patch
---

Attach custom labels to your containers to help with observability and attribution. Set a `labels` property on your `Container` subclass, or pass `labels` in the `startOptions` argument to `start()` / `startAndWaitForPorts()`, and tag containers by tenant, environment, feature flag, canary cohort, or any other dimension you want to track. In local development, labels are visible on the underlying Docker container via `docker inspect`.

```ts
class MyContainer extends Container {
  labels = { tenant: 'acme', env: 'prod' };
}
```
