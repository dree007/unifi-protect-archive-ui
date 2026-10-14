import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";

import { afterAll } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import type { ProtectConfig } from "@/server/protect/config";

import { FAKE_API_KEY, PROTECT_API_BASE, protectCameras } from "./protect-fixtures";

export { eventMessage, FAKE_API_KEY, protectCameras, SYNTHETIC_EVENT } from "./protect-fixtures";

const tls = {
  key: readFileSync(new URL("./tls/test-only-localhost.key", import.meta.url)),
  cert: readFileSync(new URL("./tls/test-only-localhost.crt", import.meta.url)),
};

const BASE = PROTECT_API_BASE;

interface Route {
  status?: number;
  body?: unknown;
  /** Raw body (e.g. invalid JSON); overrides `body`. */
  raw?: string;
  /** Delay before answering (timeout tests). */
  delayMs?: number;
}

/**
 * Local stand-in for the Protect Integration API: REST endpoints and the event WebSocket on
 * one server. Closed after the test file.
 */
export class FakeProtect {
  readonly requests: { path: string; apiKey: string | undefined }[] = [];
  readonly upgrades: { apiKey: string | undefined }[] = [];
  readonly sockets = new Set<WebSocket>();
  routes: Record<string, Route> = {
    "/meta/info": { body: { applicationVersion: "7.1.87" } },
    "/cameras": { body: protectCameras() },
  };
  /** HTTP status to reject WebSocket upgrades with (e.g. 401), or undefined to accept. */
  rejectUpgradesWith: number | undefined;
  private connectionWaiters: ((socket: WebSocket) => void)[] = [];
  private readonly wss = new WebSocketServer({ noServer: true });

  private constructor(
    readonly server: http.Server,
    readonly secure: boolean,
  ) {}

  static async start({ secure = false } = {}): Promise<FakeProtect> {
    const server = secure ? https.createServer(tls) : http.createServer();
    const fake = new FakeProtect(server, secure);
    server.on("request", (request, response) => fake.handle(request, response));
    server.on("upgrade", (request, socket, head) => fake.upgrade(request, socket, head));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    afterAll(() => fake.stop());
    return fake;
  }

  get baseUrl(): string {
    const { port } = this.server.address() as AddressInfo;
    return `${this.secure ? "https" : "http"}://127.0.0.1:${port}`;
  }

  config(overrides: Partial<ProtectConfig> = {}): ProtectConfig {
    return { baseUrl: this.baseUrl, apiKey: FAKE_API_KEY, tlsVerify: !this.secure, ...overrides };
  }

  /** Resolves with the next accepted WebSocket connection. */
  nextConnection(): Promise<WebSocket> {
    return new Promise((resolve) => this.connectionWaiters.push(resolve));
  }

  broadcast(message: unknown): void {
    const text = typeof message === "string" ? message : JSON.stringify(message);
    for (const socket of this.sockets) socket.send(text);
  }

  /** Server-side close of all event streams (e.g. Protect restart). */
  closeAll(code = 1012, reason = "service restart"): void {
    for (const socket of this.sockets) socket.close(code, reason);
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    this.wss.close();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(request: http.IncomingMessage, response: http.ServerResponse) {
    const apiKey = request.headers["x-api-key"] as string | undefined;
    const path = (request.url ?? "").replace(BASE, "");
    this.requests.push({ path, apiKey });
    const route = this.routes[path];
    const answer = () => {
      if (apiKey !== FAKE_API_KEY) {
        response.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
      } else if (!route) {
        response.writeHead(404).end();
      } else {
        response.writeHead(route.status ?? 200, { "content-type": "application/json" });
        response.end(route.raw ?? JSON.stringify(route.body));
      }
    };
    if (route?.delayMs) setTimeout(answer, route.delayMs).unref();
    else answer();
  }

  private upgrade(request: http.IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) {
    const apiKey = request.headers["x-api-key"] as string | undefined;
    this.upgrades.push({ apiKey });
    const status = this.rejectUpgradesWith ?? (apiKey === FAKE_API_KEY ? undefined : 401);
    if (status !== undefined || request.url !== `${BASE}/subscribe/events`) {
      socket.end(`HTTP/1.1 ${status ?? 404} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.sockets.add(ws);
      ws.on("close", () => this.sockets.delete(ws));
      const waiters = this.connectionWaiters;
      this.connectionWaiters = [];
      for (const resolve of waiters) resolve(ws);
    });
  }
}
