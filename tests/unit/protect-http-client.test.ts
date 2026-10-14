import https from "node:https";

import { describe, expect, it } from "vitest";

import { ProtectPayloadError } from "@/server/protect/payloads";
import { ProtectHttpClient, ProtectHttpError, ProtectNetworkError } from "@/server/protect/protect-http-client";

import { FAKE_API_KEY, FakeProtect } from "../support/fake-protect";

/** Error, its string form and JSON must not contain the API key. */
function expectNoSecret(error: unknown) {
  const texts = [String(error), error instanceof Error ? (error.stack ?? "") : "", JSON.stringify(error)];
  for (const text of texts) expect(text).not.toContain(FAKE_API_KEY);
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the request to fail");
    },
    (error: unknown) => error,
  );
}

describe("ProtectHttpClient", async () => {
  const protect = await FakeProtect.start();

  it("reads meta info and sends the API key header", async () => {
    const client = new ProtectHttpClient(protect.config());
    try {
      expect(await client.getMetaInfo()).toEqual({ applicationVersion: "7.1.87" });
      expect(protect.requests.at(-1)).toEqual({ path: "/meta/info", apiKey: FAKE_API_KEY });
    } finally {
      client.close();
    }
  });

  it("reads and validates the camera list", async () => {
    const client = new ProtectHttpClient(protect.config());
    try {
      const { cameras, invalid } = await client.getCameras();
      expect(cameras.map((camera) => camera.name)).toEqual(["Garden", "Driveway", "Doorbell", "Garage", "Garage 2", "Front Door"]);
      expect(invalid).toEqual([]);
    } finally {
      client.close();
    }
  });

  it.each([401, 403])("reports HTTP %i as an authentication error without leaking the key", async (status) => {
    protect.routes["/meta/info"] = { status, body: { error: "nope" } };
    const client = new ProtectHttpClient(protect.config());
    try {
      const error = await failure(client.getMetaInfo());
      expect(error).toBeInstanceOf(ProtectHttpError);
      expect(error).toMatchObject({ status, isAuthError: true });
      expect(String(error)).toMatch(/rejected the API key/);
      expectNoSecret(error);
    } finally {
      client.close();
      protect.routes["/meta/info"] = { body: { applicationVersion: "7.1.87" } };
    }
  });

  it("treats a wrong key like Protect does (401)", async () => {
    const client = new ProtectHttpClient(protect.config({ apiKey: "wrong" }));
    try {
      expect(await failure(client.getCameras())).toMatchObject({ status: 401, isAuthError: true });
    } finally {
      client.close();
    }
  });

  it("reports HTTP 500 as a non-auth error", async () => {
    protect.routes["/cameras"] = { status: 500, raw: "internal" };
    const client = new ProtectHttpClient(protect.config());
    try {
      const error = await failure(client.getCameras());
      expect(error).toMatchObject({ status: 500, isAuthError: false, message: expect.stringContaining("HTTP 500") });
    } finally {
      client.close();
      delete protect.routes["/cameras"].status;
    }
  });

  it("rejects invalid JSON and unexpected shapes", async () => {
    const client = new ProtectHttpClient(protect.config());
    try {
      protect.routes["/cameras"] = { raw: "{not json" };
      expect(await failure(client.getCameras())).toBeInstanceOf(ProtectPayloadError);
      protect.routes["/cameras"] = { body: { cameras: [] } };
      expect(await failure(client.getCameras())).toBeInstanceOf(ProtectPayloadError);
    } finally {
      client.close();
    }
  });

  it("times out", async () => {
    protect.routes["/meta/info"] = { body: { applicationVersion: "7.1.87" }, delayMs: 500 };
    const client = new ProtectHttpClient(protect.config(), { timeoutMs: 100 });
    try {
      const error = await failure(client.getMetaInfo());
      expect(error).toBeInstanceOf(ProtectNetworkError);
      expect(error).toMatchObject({ code: "ETIMEDOUT", message: expect.stringContaining("within 100 ms") });
    } finally {
      client.close();
      protect.routes["/meta/info"] = { body: { applicationVersion: "7.1.87" } };
    }
  });

  it("reports an unreachable Protect as a network error", async () => {
    const client = new ProtectHttpClient({ baseUrl: "http://127.0.0.1:1", apiKey: FAKE_API_KEY, tlsVerify: true });
    try {
      const error = await failure(client.getMetaInfo());
      expect(error).toMatchObject({ name: "ProtectNetworkError", code: "ECONNREFUSED" });
      expectNoSecret(error);
    } finally {
      client.close();
    }
  });
});

describe("ProtectHttpClient over HTTPS with a self-signed certificate", async () => {
  const protect = await FakeProtect.start({ secure: true });

  it("rejects the certificate when TLS verification is on (default)", async () => {
    const client = new ProtectHttpClient(protect.config({ tlsVerify: true }));
    try {
      const error = await failure(client.getMetaInfo());
      expect(error).toBeInstanceOf(ProtectNetworkError);
      expect((error as ProtectNetworkError).code).toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY|CERT/);
    } finally {
      client.close();
    }
  });

  it("accepts it with TLS verification off, for this client only", async () => {
    const client = new ProtectHttpClient(protect.config({ tlsVerify: false }));
    try {
      expect(await client.getMetaInfo()).toEqual({ applicationVersion: "7.1.87" });
    } finally {
      client.close();
    }
    // Process-wide TLS is untouched: a plain request still rejects the certificate.
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    const plain = await new Promise<unknown>((resolve) => {
      https.get(`${protect.baseUrl}/proxy/protect/integration/v1/meta/info`, () => resolve("connected")).on("error", resolve);
    });
    expect(plain).toBeInstanceOf(Error);
  });
});
