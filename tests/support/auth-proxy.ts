import http from "node:http";
import type { AddressInfo } from "node:net";

/** Test-only authorization gate. No sessions, identity provider or production configuration.
 * Every request is checked before streaming to a fixed upstream, including /api and HEAD.
 * Tests toggle the decision to simulate external login/access revocation.
 */
export async function createAuthProxy(upstream: string) {
  const target = new URL(upstream);
  let authorized = false;
  const requests: { method: string; path: string; authorized: boolean; cacheProbe: boolean }[] = [];
  const server = http.createServer((request, response) => {
    requests.push({
      method: request.method ?? "GET", path: request.url ?? "/", authorized,
      cacheProbe: request.headers["x-unifi-test-probe"] === "cache-regression",
    });
    if (!authorized) {
      response.writeHead(401, { "Cache-Control": "no-store", "Content-Length": "0" });
      response.end();
      return;
    }
    const outgoing = http.request({
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: request.url,
      // Match a reverse proxy that preserves the public Host; Next checks Origin against it.
      // Overwrite forwarded headers rather than trusting values supplied by the test client.
      headers: {
        ...request.headers,
        host: request.headers.host ?? target.host,
        "x-forwarded-host": request.headers.host ?? target.host,
        "x-forwarded-proto": "http",
      },
    }, (incoming) => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.on("error", () => response.destroy());
      incoming.pipe(response);
    });
    outgoing.on("error", () => {
      if (!response.headersSent) response.writeHead(502, { "Cache-Control": "no-store" });
      response.end();
    });
    response.on("close", () => outgoing.destroy());
    request.on("aborted", () => outgoing.destroy());
    request.pipe(outgoing);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    setAuthorized(value: boolean) { authorized = value; },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
