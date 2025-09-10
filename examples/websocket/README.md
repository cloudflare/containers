# WebSocket Container Fixture

Tests WebSocket forwarding capabilities including:

- WebSocket connection proxying via `container.fetch()`
- WebSocket echo server in container
- Real-time message handling and bidirectional communication
- Container lifecycle with WebSocket services

## Usage

```bash
npm install
npm run dev
npm test
```

## Endpoints

- `/fetch/ws` - WebSocket connection via `container.fetch()`
- `/stop` - Stop container

## Manual Testing

```bash
wscat -c "ws://localhost:8787/fetch/ws?id=test1"
```