import { createServer } from 'http';

// Time the health endpoint starts returning 2xx. Lets tests exercise
// readiness checks that need to wait for app-level warmup — not just the
// port binding.
const HEALTHY_AFTER_MS = Number(process.env.HEALTHY_AFTER_MS ?? '0');
const startupTime = Date.now();

const server = createServer(function (req, res) {
  if (req.url?.startsWith('/containerFetchNoContent')) {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/health') {
    const ready = Date.now() - startupTime >= HEALTHY_AFTER_MS;
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'text/plain' });
    res.end(ready ? 'ok' : 'warming up');
    return;
  }

  if (req.url === '/error') {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal server error');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`Hello from test container! process.env.MESSAGE: ${process.env.MESSAGE}`);
});

server.listen(8080, function () {
  console.log(`Test server listening on port 8080`);
});

server.on('exit', () => {
  console.log('Test server exiting');
});

process.on('SIGTERM', () => {
  server.close(() => {
    process.exit(0);
  });
});
