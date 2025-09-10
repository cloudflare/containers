import { createServer } from "http";
import { WebSocketServer } from 'ws';

const server = createServer(function (req, res) {
  if (req.url === '/error') {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal server error");
    return;
  }
  
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`Hello from WebSocket test container! process.env.MESSAGE: ${process.env.MESSAGE}`);
});

// Create WebSocket server
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', function connection(ws, req) {
  console.log('WebSocket connection established');
  
  ws.on('message', function message(data) {
    console.log('WebSocket received:', data.toString());
    // Echo the message back with container info
    ws.send(`Echo from container: ${data.toString()} | MESSAGE: ${process.env.MESSAGE}`);
  });
  
  ws.on('close', function close() {
    console.log('WebSocket connection closed');
  });
  
  // Send welcome message
  ws.send(`WebSocket connected to container! MESSAGE: ${process.env.MESSAGE}`);
});

server.listen(8080, function () {
  console.log(`WebSocket test server listening on port 8080`);
});

server.on("exit", () => {
  console.log("WebSocket test server exiting");
})

