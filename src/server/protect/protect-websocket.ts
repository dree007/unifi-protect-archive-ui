import WebSocket from "ws";

import type { ProtectConfig } from "./config";
import { INTEGRATION_API_PATH } from "./protect-http-client";

export const EVENTS_PATH = `${INTEGRATION_API_PATH}/subscribe/events`;

/** `https://host` → `wss://host/proxy/protect/integration/v1/subscribe/events` (http → ws). */
export function eventStreamUrl(baseUrl: string): string {
  const url = new URL(`${baseUrl}${EVENTS_PATH}`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/**
 * Opens the Protect event stream. Authentication via `X-API-Key`; TLS verification is set on
 * this connection only (`rejectUnauthorized`), never process-wide.
 */
export function openEventStream(config: ProtectConfig, { handshakeTimeoutMs = 10_000 } = {}): WebSocket {
  return new WebSocket(eventStreamUrl(config.baseUrl), {
    headers: { "X-API-Key": config.apiKey },
    rejectUnauthorized: config.tlsVerify,
    handshakeTimeout: handshakeTimeoutMs,
    // Never follow redirects with the API key to another host.
    followRedirects: false,
  });
}
