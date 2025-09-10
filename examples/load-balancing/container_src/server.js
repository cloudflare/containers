import { createServer } from "http";

const server = createServer(function (req, res) {
  if (req.url === '/error') {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal server error");
    return;
  }
  
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`Hello from load balancing container!`);
});

server.listen(8080, function () {
  console.log(`Load balancing server listening on port 8080`);
});

server.on("exit", () => {
  console.log("Load balancing server exiting");
})

