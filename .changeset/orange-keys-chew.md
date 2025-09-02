---
'@cloudflare/containers': patch
---

add function overload to startAndWaitForPorts()

You can now use `startAndWaitForPorts({startOptions: {envVars: {FOO:"BAR"}}})` instead of `startAndWaitForPorts(undefined, {},  {envVars: {FOO:"BAR"}})`, although that is still supported.
