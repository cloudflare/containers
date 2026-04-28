---
'@cloudflare/containers': patch
---

Fix subclass `sleepAfter` overrides being ignored during the initial activity timeout setup. Previously, the base `Container` constructor called `renewActivityTimeout()` inside `blockConcurrencyWhile()` before subclass class-field initializers ran, so the first `sleepAfterMs` was always computed from the base default (`'10m'`) regardless of whether the subclass declared `sleepAfter = '2h'`. A container could then be killed by the activity timeout before the subclass's longer window took effect on the next `renewActivityTimeout` call. Declarations like:

```ts
class BigContainer extends Container {
  sleepAfter = '2h';
}
```

are now honored from the very first alarm check.
