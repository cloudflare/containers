---
'@cloudflare/containers': patch
---

Fix containers never sleeping after a client abandons a response body. `containerFetch` counted a
proxied response as in flight until its body had been fully piped. A body nobody read stalled on
backpressure, so the in-flight counter never dropped back to zero and every alarm renewed
`sleepAfter`. The request now leaves the in-flight count as soon as the container answers, and
bytes flowing through the response body renew the activity timeout instead.
