---
'@cloudflare/containers': patch
---

Fix containers never sleeping after a client aborts a request the container has not answered.
`containerFetch` counted a request as in flight until the proxied fetch settled. If the client
disconnected while the container was still working and that fetch never settled, the count stayed
above zero and every alarm renewed `sleepAfter`. The request's abort signal now releases the count
too. The runtime fires that signal on client disconnect when the `enable_request_signal`
compatibility flag is set.
