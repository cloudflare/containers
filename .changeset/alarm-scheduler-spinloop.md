---
'@cloudflare/containers': patch
---

Fix a spinloop in the alarm scheduler that could saturate the Durable Object event loop and cause WebSocket upgrades to be canceled at 0ms wallclock while HTTP traffic to the same DO continued to succeed. The `alarm()` handler previously paired an in-memory `setTimeout` sleep with an unconditional `setAlarm(Date.now())` on exit. Any external call to `scheduleNextAlarm()` during the sleep resolved the internal Promise, and the handler's exit path would then overwrite the caller's future alarm with one scheduled for "now" — causing the runtime to refire the alarm immediately. Under load (for example, a `startAndWaitForPorts` retry loop or partysocket reconnect storm), this escalated into a ~300ms alarm cadence matching `INSTANCE_POLL_INTERVAL_MS`.

The handler is now durable-by-default: it completes its work and re-arms the storage alarm to the earliest of the next scheduled task, `sleepAfter` expiration, or a 3-minute heartbeat, floored at 100ms. `scheduleNextAlarm()` is idempotent — concurrent callers converge on the earliest requested time instead of clobbering each other via the removed in-memory Promise/timeout coordination.

No behavior change for activity renewal, connection handling, or `onStart`/`onStop` lifecycle hooks.
