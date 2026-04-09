import { createServer, get } from 'http';
import { get as httpsGet } from 'https';

const server = createServer(function (req, res) {
  const url = new URL(req.url, 'http://localhost:8080');

  // Outbound HTTP proxy: the container makes an HTTP request to the given host.
  const proxyTarget = url.searchParams.get('proxy');
  if (proxyTarget) {
    get('http://' + proxyTarget, proxyRes => {
      let body = '';
      proxyRes.on('data', chunk => {
        body += chunk;
      });
      proxyRes.on('end', () => {
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'text/plain' });
        res.end(body);
      });
    }).on('error', err => {
      res.writeHead(520, { 'Content-Type': 'text/plain' });
      res.end('proxy error: ' + err.message);
    });
    return;
  }

  // Outbound HTTPS proxy: uses NODE_EXTRA_CA_CERTS (set via env) to trust
  // the Cloudflare containers CA for intercepted HTTPS.
  const proxyHttpsTarget = url.searchParams.get('proxy_https');
  if (proxyHttpsTarget) {
    httpsGet('https://' + proxyHttpsTarget, proxyRes => {
      let body = '';
      proxyRes.on('data', chunk => {
        body += chunk;
      });
      proxyRes.on('end', () => {
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'text/plain' });
        res.end(body);
      });
    }).on('error', err => {
      res.writeHead(520, { 'Content-Type': 'text/plain' });
      res.end('proxy_https error: ' + err.message);
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hello from egress test container');
});

server.listen(8080, function () {
  console.log('Egress test server listening on port 8080');
});

process.on('SIGTERM', () => {
  server.close(() => {
    process.exit(0);
  });
});
