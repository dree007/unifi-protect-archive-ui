// Stand-in for a UniFi Protect console in the Docker integration test (tests/docker/run.mts):
// the Integration API (HTTPS, self-signed test certificate) and the event WebSocket on :8443,
// as the worker container sees a real console on the LAN – over the normal bridge network.
// A plain-HTTP control API on :8080 lets the test runner drive it:
//
//   POST /control/event          body = WebSocket message to broadcast (Protect event JSON)
//   POST /control/api-key        body = the API key accepted from now on (e.g. to simulate a revoked key)
//   POST /control/close          drop all event streams (Protect restart)
//   GET  /control/state          { sockets, requests, upgrades }
//
// Bundled by run.mts with esbuild and started inside the application image (node only).
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

import { WebSocketServer, type WebSocket } from "ws";

import { FAKE_API_KEY, PROTECT_API_BASE, protectCameras } from "../support/protect-fixtures";

const tlsDir = process.env.FAKE_PROTECT_TLS_DIR ?? "/fake/tls";
let apiKey = FAKE_API_KEY;
const sockets = new Set<WebSocket>();
const stats = { requests: 0, upgrades: 0, rejected: 0 };
const wss = new WebSocketServer({ noServer: true });

const api = https.createServer({
  key: readFileSync(`${tlsDir}/test-only-localhost.key`),
  cert: readFileSync(`${tlsDir}/test-only-localhost.crt`),
});
api.on("request", (request, response) => {
  stats.requests++;
  const path = (request.url ?? "").replace(PROTECT_API_BASE, "");
  if (request.headers["x-api-key"] !== apiKey) {
    stats.rejected++;
    response.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  const routes: Record<string, unknown> = { "/meta/info": { applicationVersion: "7.1.87" }, "/cameras": protectCameras() };
  if (!(path in routes)) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(routes[path]));
});
api.on("upgrade", (request, socket, head) => {
  stats.upgrades++;
  if (request.headers["x-api-key"] !== apiKey || request.url !== `${PROTECT_API_BASE}/subscribe/events`) {
    stats.rejected++;
    socket.end("HTTP/1.1 401 Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
  });
});

const control = http.createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  switch (`${request.method} ${request.url}`) {
    case "POST /control/event":
      for (const socket of sockets) socket.send(body);
      break;
    case "POST /control/api-key":
      apiKey = body.trim();
      // A revoked key also ends the running streams, like Protect does.
      for (const socket of sockets) socket.close(1008, "unauthorized");
      break;
    case "POST /control/close":
      for (const socket of sockets) socket.close(1012, "service restart");
      break;
    case "GET /control/state":
      break;
    default:
      response.writeHead(404).end();
      return;
  }
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sockets: sockets.size, ...stats }));
});

api.listen(8443, "0.0.0.0");
control.listen(8080, "0.0.0.0");
console.log("fake Protect listening: API/WebSocket https://:8443, control http://:8080");
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    for (const socket of sockets) socket.terminate();
    api.close();
    control.close();
    process.exit(0);
  });
}
