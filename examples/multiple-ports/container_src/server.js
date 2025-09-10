import { createServer } from "http";
import { setTimeout } from "timers/promises";

const server = createServer(function (req, res) {
  if (req.url === '/error') {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal server error");
    return;
  }
  
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`Hello from test container server one! process.env.MESSAGE: ${process.env.MESSAGE}`);
});

server.listen(8080, function () {
  console.log(`Test server listening on port 8080`);
});
server.on("exit", () => {
  console.log("Test server one exiting");
})



await setTimeout(5000)


const server2 = createServer(function (req, res) {
  if (req.url === '/error') {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal server error");
    return;
  }
  
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`Hello from test container server two! process.env.MESSAGE: ${process.env.MESSAGE}`);
});
server2.listen(8081, function () {
  console.log(`Test server two listening on port 8081`);
}); 

server2.on("exit", function () {
  console.log("Test server two exiting");
}); 


