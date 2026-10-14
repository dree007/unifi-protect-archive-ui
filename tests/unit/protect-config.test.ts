import { describe, expect, it } from "vitest";

import {
  normalizeProtectUrl,
  parseTlsVerify,
  ProtectConfigError,
  readProtectConfig,
  securityNotes,
} from "@/server/protect/config";

describe("Protect configuration", () => {
  it("reads and normalizes a valid configuration", () => {
    expect(
      readProtectConfig({
        UNIFI_PROTECT_URL: " https://192.168.0.1/ ",
        UNIFI_PROTECT_API_KEY: " key ",
        UNIFI_PROTECT_TLS_VERIFY: "false",
      }),
    ).toEqual({ baseUrl: "https://192.168.0.1", apiKey: "key", tlsVerify: false });
  });

  it.each([
    ["https://192.168.0.1", "https://192.168.0.1"],
    ["https://192.168.0.1///", "https://192.168.0.1"],
    ["https://unifi.example.com:8443/", "https://unifi.example.com:8443"],
    ["https://proxy.example.com/unifi/", "https://proxy.example.com/unifi"],
    ["HTTP://192.168.0.1", "http://192.168.0.1"],
  ])("normalizes %s", (raw, expected) => {
    expect(normalizeProtectUrl(raw)).toBe(expected);
  });

  it.each([
    [undefined, /not set/],
    ["   ", /not set/],
    ["192.168.0.1", /not a valid URL/],
    ["ftp://192.168.0.1", /https/],
    ["wss://192.168.0.1", /https/],
    ["https://user:pw@192.168.0.1", /credentials/],
    ["https://192.168.0.1/?key=x", /query string/],
  ])("rejects URL %j", (raw, message) => {
    expect(() => normalizeProtectUrl(raw)).toThrow(ProtectConfigError);
    expect(() => normalizeProtectUrl(raw)).toThrow(message);
  });

  it("requires an API key", () => {
    expect(() => readProtectConfig({ UNIFI_PROTECT_URL: "https://192.168.0.1" })).toThrow(/UNIFI_PROTECT_API_KEY/);
    expect(() => readProtectConfig({ UNIFI_PROTECT_URL: "https://192.168.0.1", UNIFI_PROTECT_API_KEY: " " })).toThrow(
      ProtectConfigError,
    );
  });

  it("verifies TLS by default and accepts explicit values", () => {
    expect(parseTlsVerify(undefined)).toBe(true);
    expect(parseTlsVerify("")).toBe(true);
    for (const value of ["true", "TRUE", "1", "yes"]) expect(parseTlsVerify(value)).toBe(true);
    for (const value of ["false", "False", "0", "no", "off"]) expect(parseTlsVerify(value)).toBe(false);
    expect(() => parseTlsVerify("maybe")).toThrow(/UNIFI_PROTECT_TLS_VERIFY/);
  });

  it("points out weakened transport security", () => {
    expect(securityNotes({ baseUrl: "https://a", apiKey: "k", tlsVerify: true })).toEqual([]);
    expect(securityNotes({ baseUrl: "https://a", apiKey: "k", tlsVerify: false })).toEqual([
      expect.stringMatching(/verification is disabled/),
    ]);
    expect(securityNotes({ baseUrl: "http://a", apiKey: "k", tlsVerify: true })).toEqual([expect.stringMatching(/plain http/)]);
  });

  it("never puts the API key into error messages", () => {
    const apiKey = "super-secret-key";
    for (const env of [
      { UNIFI_PROTECT_URL: "nope", UNIFI_PROTECT_API_KEY: apiKey },
      { UNIFI_PROTECT_URL: "https://a", UNIFI_PROTECT_API_KEY: apiKey, UNIFI_PROTECT_TLS_VERIFY: "x" },
    ]) {
      expect(() => readProtectConfig(env)).toThrow(expect.not.objectContaining({ message: expect.stringContaining(apiKey) }));
    }
  });
});
