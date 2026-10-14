import http from "node:http";
import https from "node:https";

import type { ProtectConfig } from "./config";
import { parseCameraList, parseMetaInfo, ProtectPayloadError, type CameraListResult, type ProtectMetaInfo } from "./payloads";

/**
 * Minimal read-only client for the official UniFi Protect Integration API, built on Node's
 * http/https modules. TLS verification is configured on this client's own agent only;
 * process-wide TLS settings are never touched. The API key is sent as `X-API-Key` and never
 * appears in errors or logs.
 */

export const INTEGRATION_API_PATH = "/proxy/protect/integration/v1";

/** Protect answered with a non-2xx status. */
export class ProtectHttpError extends Error {
  override name = "ProtectHttpError";
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(
      status === 401 || status === 403
        ? `Protect rejected the API key (HTTP ${status} for ${path}). Check UNIFI_PROTECT_API_KEY.`
        : `Protect responded with HTTP ${status} for ${path}.`,
    );
  }

  /** Authentication/authorization failures do not go away by retrying. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** Protect was not reachable (DNS, connection refused, TLS, timeout, …). */
export class ProtectNetworkError extends Error {
  override name = "ProtectNetworkError";
  constructor(
    message: string,
    readonly code: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface ProtectHttpClientOptions {
  /** Whole request including the body (default 10 s). */
  timeoutMs?: number;
  /** Upper bound for a response body (default 5 MB). */
  maxResponseBytes?: number;
}

export class ProtectHttpClient {
  private readonly agent: http.Agent;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(
    private readonly config: ProtectConfig,
    { timeoutMs = 10_000, maxResponseBytes = 5 * 1024 * 1024 }: ProtectHttpClientOptions = {},
  ) {
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.agent = config.baseUrl.startsWith("https:")
      ? new https.Agent({ keepAlive: true, rejectUnauthorized: config.tlsVerify })
      : new http.Agent({ keepAlive: true });
  }

  async getMetaInfo(): Promise<ProtectMetaInfo> {
    return parseMetaInfo(await this.getJson("/meta/info"));
  }

  async getCameras(): Promise<CameraListResult> {
    return parseCameraList(await this.getJson("/cameras"));
  }

  /** Releases kept-alive connections. */
  close(): void {
    this.agent.destroy();
  }

  private getJson(path: string): Promise<unknown> {
    const fullPath = `${INTEGRATION_API_PATH}${path}`;
    const url = new URL(`${this.config.baseUrl}${fullPath}`);
    const transport = url.protocol === "https:" ? https : http;

    return new Promise((resolve, reject) => {
      const request = transport.request(
        url,
        {
          method: "GET",
          agent: this.agent,
          headers: { "X-API-Key": this.config.apiKey, Accept: "application/json" },
          signal: AbortSignal.timeout(this.timeoutMs),
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status < 200 || status > 299) {
            response.resume(); // discard the body, keep the connection usable
            reject(new ProtectHttpError(status, fullPath));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > this.maxResponseBytes) {
              request.destroy();
              reject(new ProtectPayloadError(`response of ${fullPath} exceeds ${this.maxResponseBytes} bytes.`));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
              reject(new ProtectPayloadError(`response of ${fullPath} is not valid JSON.`));
            }
          });
          response.on("error", (error) => reject(toNetworkError(error, fullPath, this.timeoutMs)));
        },
      );
      request.on("error", (error) => reject(toNetworkError(error, fullPath, this.timeoutMs)));
      request.end();
    });
  }
}

function toNetworkError(error: Error, path: string, timeoutMs: number): ProtectNetworkError {
  const code = (error as NodeJS.ErrnoException).code;
  if (error.name === "AbortError" || error.name === "TimeoutError" || code === "ABORT_ERR") {
    return new ProtectNetworkError(`Protect did not respond within ${timeoutMs} ms (${path}).`, "ETIMEDOUT", {
      cause: error,
    });
  }
  // Node's network/TLS messages contain no request headers, so the API key cannot leak here.
  return new ProtectNetworkError(`Cannot reach Protect for ${path}: ${error.message}${code ? ` (${code})` : ""}.`, code, {
    cause: error,
  });
}
