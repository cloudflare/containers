const { createServer } = require("http");

const webSocketEnabled = process.env.WS_ENABLED === "true";

// Create HTTP server
const server = createServer(function (req, res) {

	if (req.url === "/error") {
		throw new Error("This is a test error for the simple-node-app");
	}

	res.writeHead(200, { "Content-Type": "text/plain" });
	res.write("Hello World! " + process.env.MESSAGE);
	res.end();
});


server.listen(8080, function () {
	console.log("Server listening on port 8080");

});
