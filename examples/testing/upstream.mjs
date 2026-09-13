import { createServer } from "node:http";

const server = createServer((request, response) => {
  if (request.method !== "GET" || request.url !== "/greeting") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  response.end("hello 日本語");
});
server.listen(8787, "127.0.0.1", () => {
  console.log("Test upstream listening on http://127.0.0.1:8787");
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close();
    server.closeAllConnections();
  });
}
