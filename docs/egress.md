# Egress (Outbound Interception)

Containers make outbound HTTP and HTTPS requests to talk to external services.
By default, whether those requests succeed depends on `enableInternet`. The
egress system lets you intercept, rewrite, allow, or block those requests
before they leave the Cloudflare network.

## Setup

Export `ContainerProxy` from your Worker entrypoint. Without this export,
outbound interception will not work.

```ts
export { ContainerProxy } from '@cloudflare/containers';
```

## Configuration

All of the following are instance properties on your `Container` subclass.

### `enableInternet`

Controls whether the container can access the public internet by default.

```ts
enableInternet = false; // block all outbound by default
```

### `interceptHttps`

When `true`, outbound HTTPS traffic is also intercepted through the same
handler chain as HTTP. The container must trust the Cloudflare-provided CA
certificate at `/etc/cloudflare/certs/cloudflare-containers-ca.crt`.

```ts
interceptHttps = true;
```

**Trusting the CA certificate in your container:**

The CA certificate is ephemeral and only available at runtime, so it cannot be
baked into your Docker image. Instead, copy it into the distro's certificate
directory and refresh the trust store in your entrypoint before your
application starts.

| Distribution  | Certificate directory                        | Update command           |
| ------------- | -------------------------------------------- | ------------------------ |
| Alpine        | `/usr/local/share/ca-certificates/`          | `update-ca-certificates` |
| Debian/Ubuntu | `/usr/local/share/ca-certificates/`          | `update-ca-certificates` |
| Fedora/RHEL   | `/etc/pki/ca-trust/source/anchors/`          | `update-ca-trust`        |
| Arch          | `/etc/ca-certificates/trust-source/anchors/` | `trust extract-compat`   |

Example entrypoint snippets:

Alpine or Debian/Ubuntu:

```sh
cp /etc/cloudflare/certs/cloudflare-containers-ca.crt \
  /usr/local/share/ca-certificates/cloudflare-containers-ca.crt && \
update-ca-certificates
```

Fedora or RHEL:

```sh
cp /etc/cloudflare/certs/cloudflare-containers-ca.crt \
  /etc/pki/ca-trust/source/anchors/cloudflare-containers-ca.crt && \
update-ca-trust
```

Arch:

```sh
cp /etc/cloudflare/certs/cloudflare-containers-ca.crt \
  /etc/ca-certificates/trust-source/anchors/cloudflare-containers-ca.crt && \
trust extract-compat
```

Alpine/Debian/Ubuntu `Container` entrypoint example:

```ts
export class MyContainer extends Container {
  interceptHttps = true;
  entrypoint = [
    'sh',
    '-lc',
    'cp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/cloudflare-containers-ca.crt && update-ca-certificates && exec node server.js',
  ];
}
```

For Fedora/RHEL or Arch, swap the destination path and trust-store refresh
command to match the table above.

Most languages and HTTP clients (curl, Node.js, Python requests, Go's
`net/http`) will then trust it automatically via the system root store.

If your runtime does not use the system store, you can point it at the
certificate directly via environment variables:

```bash
# Node.js
export NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt

# Python (requests)
export REQUESTS_CA_BUNDLE=/etc/cloudflare/certs/cloudflare-containers-ca.crt

# curl
curl --cacert /etc/cloudflare/certs/cloudflare-containers-ca.crt https://example.com
```

### `allowedHosts`

A list of hostname patterns. When non-empty, it acts as a **whitelist gate**:
only matching hosts can proceed past this check. Hosts that do not match are
blocked with HTTP 520.

Supports simple glob patterns where `*` matches any sequence of characters.

```ts
allowedHosts = ['api.stripe.com', '*.example.com'];
```

Behaviour depends on whether a catch-all `outbound` handler is defined:

- **With `outbound`:** Only matching hosts reach the catch-all handler.
  Everything else is blocked, even if `enableInternet` is `true`.
- **Without `outbound`:** Matching hosts get internet access, regardless of
  `enableInternet`. Non-matching hosts fall through to `enableInternet`.

### `deniedHosts`

A list of hostname patterns. Matching hosts are **blocked unconditionally**
(HTTP 520). This overrides everything else in the chain, including per-host
handlers set via `outboundByHost`.

Supports the same simple glob patterns as `allowedHosts`.

```ts
deniedHosts = ['evil.com', '*.malware.net'];
```

## Outbound handlers

### `outboundByHost`

Map of hostname to handler function. Handles requests to specific hosts.

```ts
MyContainer.outboundByHost = {
  'api.openai.com': (req, env, ctx) => {
    // custom logic for openai
    return fetch(req);
  },
};
```

### `outbound`

Catch-all handler invoked for any host that was not handled by a more specific
rule. When this is defined, all outbound HTTP is intercepted (not just specific
hosts).

```ts
MyContainer.outbound = (req, env, ctx) => {
  console.log('outbound request to', new URL(req.url).hostname);
  return fetch(req);
};
```

### `outboundHandlers`

Named handlers that can be referenced at runtime via `setOutboundHandler()` or
`setOutboundByHost()`. This is how you swap handler logic without redeploying.

```ts
MyContainer.outboundHandlers = {
  async github(req, env, ctx) {
    return new Response('handled by github handler');
  },
  async logging(req, env, ctx) {
    console.log(req.url);
    return fetch(req);
  },
};
```

## Runtime methods

These methods modify the outbound configuration of a running container
instance. Changes are persisted across Durable Object restarts.

| Method                                         | Description                                                  |
| ---------------------------------------------- | ------------------------------------------------------------ |
| `setOutboundHandler(name, ...params)`          | Set the catch-all to a named handler from `outboundHandlers` |
| `setOutboundByHost(hostname, name, ...params)` | Set a per-host handler at runtime                            |
| `removeOutboundByHost(hostname)`               | Remove a runtime per-host override                           |
| `setOutboundByHosts(handlers)`                 | Replace all runtime per-host overrides at once               |
| `setAllowedHosts(hosts)`                       | Replace the allowed hosts list                               |
| `setDeniedHosts(hosts)`                        | Replace the denied hosts list                                |
| `allowHost(hostname)`                          | Add a single host to the allowed list                        |
| `denyHost(hostname)`                           | Add a single host to the denied list                         |
| `removeAllowedHost(hostname)`                  | Remove a host from the allowed list                          |
| `removeDeniedHost(hostname)`                   | Remove a host from the denied list                           |

## Processing order

When the container makes an outbound request, it is evaluated against the
following rules **in order**. The first match wins.

### Step 1 — Denied hosts

If the hostname matches any `deniedHosts` pattern, the request is blocked
(HTTP 520). This is the highest priority check. It overrides everything else:
per-host handlers, the catch-all, `allowedHosts`, and `enableInternet`.

### Step 2 — Allowed hosts gate

If `allowedHosts` is non-empty and the hostname does **not** match any pattern,
the request is blocked (HTTP 520). When `allowedHosts` is empty this step is
skipped entirely and all hosts proceed.

This gates everything below, including `outboundByHost`. Setting an
`outboundByHost` handler for a hostname does not allow it — it only maps what
handler runs when the host _is_ allowed. If you use `allowedHosts`, you must
include the hostname there too.

### Step 3 — Per-host handler (runtime)

If `setOutboundByHost()` was called for this exact hostname, the registered
handler is invoked.

### Step 4 — Per-host handler (static)

If `outboundByHost` contains this exact hostname, the registered handler
is invoked.

### Step 5 — Catch-all handler (runtime)

If `setOutboundHandler()` was called at runtime, that handler is invoked.

### Step 6 — Catch-all handler (static)

If `outbound` is defined, it is invoked.

### Step 7 — Allowed host internet fallback

If the hostname matched `allowedHosts` but no outbound handler above handled
it, the request is forwarded to the public internet. This is the mechanism that
lets `allowedHosts` grant internet access when `enableInternet` is `false`.

### Step 8 — `enableInternet` fallback

If `enableInternet` is `true`, the request is forwarded to the public internet.

### Step 9 — Default deny

The request is blocked (HTTP 520).

## Interception strategy

The library avoids intercepting all outbound traffic when it is not necessary.

- **Catch-all interception** (`interceptAllOutboundHttp`) is only used when a
  catch-all `outbound` handler or a runtime `setOutboundHandler` override is
  configured. All outbound HTTP goes through `ContainerProxy`.
- **Per-host interception** (`interceptOutboundHttp`) is used in all other
  cases. Only traffic to known hosts (from `outboundByHost`, `allowedHosts`,
  `deniedHosts`, and runtime overrides) is routed through `ContainerProxy`.
  Everything else follows the container's default network behaviour
  (`enableInternet`).

When `interceptHttps` is `true`:

- In catch-all mode, `interceptOutboundHttps('*', ...)` intercepts all HTTPS.
- In per-host mode, `interceptOutboundHttps(host, ...)` is called for each
  known host individually.

## Glob patterns

Both `allowedHosts` and `deniedHosts` support simple glob patterns where `*`
matches any sequence of characters.

| Pattern         | Matches                              | Does not match     |
| --------------- | ------------------------------------ | ------------------ |
| `example.com`   | `example.com`                        | `sub.example.com`  |
| `*.example.com` | `api.example.com`, `a.b.example.com` | `example.com`      |
| `google.*`      | `google.com`, `google.co.uk`         | `maps.google.com`  |
| `api.*.com`     | `api.stripe.com`, `api.test.com`     | `api.stripe.co.uk` |
| `*`             | everything                           |                    |

## Full example

```ts
import { Container, getContainer } from '@cloudflare/containers';
export { ContainerProxy } from '@cloudflare/containers';

export class MyContainer extends Container {
  defaultPort = 8080;
  enableInternet = false;
  interceptHttps = true;

  allowedHosts = ['api.stripe.com', 'google.com', 'github.com'];
  deniedHosts = ['evil.com'];
}

MyContainer.outboundByHost = {
  'google.com': (req, env, ctx) => {
    return new Response('intercepted google for ' + ctx.containerId);
  },
};

MyContainer.outboundHandlers = {
  async github(req, env, ctx) {
    return new Response('github handler, ' + ctx.params?.hello);
  },
};

MyContainer.outbound = req => {
  return new Response(`catch-all for ${new URL(req.url).hostname}`);
};

export default {
  async fetch(request, env) {
    const container = getContainer(env.MY_CONTAINER);
    await container.setOutboundByHost('github.com', 'github', { hello: 'world' });
    return await container.fetch(request);
  },
};
```

With this configuration:

| Outbound request         | Result                                                   |
| ------------------------ | -------------------------------------------------------- |
| `http://evil.com`        | Blocked (denied host, even if it were in `allowedHosts`) |
| `http://google.com`      | Passes allowed gate, handled by `outboundByHost` handler |
| `http://github.com`      | Passes allowed gate, handled by runtime `github` handler |
| `http://api.stripe.com`  | Passes allowed gate, handled by `outbound` catch-all     |
| `http://random.com`      | Blocked (not in `allowedHosts`)                          |
| `https://api.stripe.com` | Same as HTTP, intercepted via HTTPS interception         |
