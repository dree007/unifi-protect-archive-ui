import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAuthProxy } from "../support/auth-proxy";

let backend: http.Server;
let backendUrl: string;
let reachedBackend = 0;
let lastHost: string | undefined;
let lastForwardedHost: string | string[] | undefined;

beforeAll(async () => {
  backend = http.createServer((request, response) => {
    reachedBackend++;
    lastHost = request.headers.host;
    lastForwardedHost = request.headers["x-forwarded-host"];
    response.writeHead(200, { "Content-Type": "video/mp4", ETag: '"private"', "Content-Range": "bytes 0-6/7" });
    response.end("private");
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
});
afterAll(async () => {
  backend.closeAllConnections();
  await new Promise<void>((resolve) => backend.close(() => resolve()));
});

describe("synthetic external authorization boundary", () => {
  it("denies anonymous and revoked requests before contacting any backend route", async () => {
    const proxy = await createAuthProxy(backendUrl);
    try {
      const paths = ["/", "/archive", "/archive/test-event", "/cameras", "/system", "/api/health", "/api/clips/test/thumbnail?v=test", "/api/clips/test/video"];
      for (const revoked of [false, true]) {
        if (revoked) {
          proxy.setAuthorized(true);
          const authorized = await fetch(proxy.url + "/api/clips/test/video", {
            headers: { "X-Forwarded-Host": "forged.example.com" },
          });
          expect(await authorized.text()).toBe("private");
          expect(lastHost).toBe(new URL(proxy.url).host);
          expect(lastForwardedHost).toBe(new URL(proxy.url).host);
          proxy.setAuthorized(false);
        }
        const before = reachedBackend;
        for (const path of paths) {
          for (const method of ["GET", "HEAD"]) {
            const response = await fetch(proxy.url + path, {
              method,
              headers: { Range: "bytes=0-6", "If-None-Match": '"private"', "X-Authentik-Username": "forged" },
            });
            expect(response.status).toBe(401);
            expect(response.headers.get("cache-control")).toBe("no-store");
            expect(response.headers.get("etag")).toBeNull();
            expect(response.headers.get("content-range")).toBeNull();
            expect((await response.arrayBuffer()).byteLength).toBe(0);
          }
        }
        expect(reachedBackend).toBe(before);
      }
    } finally { await proxy.close(); }
  });
});
