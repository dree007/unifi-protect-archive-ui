import { describe, expect, it } from "vitest";
import { nativeInputRequest } from "../../scripts/release/fetch-native-input.mts";
const checksum = "a".repeat(64);
const env = { CI_SERVER_URL: "https://ci.example.invalid", CI_PROJECT_ID: "7", CI_JOB_TOKEN: "synthetic-token" };
describe("controlled native source input", () => {
  it("authenticates an immutable version in this project's Generic Package", () => {
    const request = nativeInputRequest("https://ci.example.invalid/api/v4/projects/7/packages/generic/native-source-input/1.0.0-abc/native-input.tar.gz", checksum, env);
    expect(request.headers).toEqual({ "JOB-TOKEN": "synthetic-token" });
  });
  it("never forwards a job token to another origin", () => expect(nativeInputRequest("https://sources.example.invalid/input.tar.gz", checksum, env).headers).toEqual({}));
  it.each(["http://ci.example.invalid/input.tar.gz", "https://user:secret@ci.example.invalid/input.tar.gz", "https://ci.example.invalid/api/v4/projects/8/packages/generic/native-source-input/1.0.0/native-input.tar.gz", "https://ci.example.invalid/api/v4/projects/7/packages/generic/other/1.0.0/input.tar.gz", "https://sources.example.invalid/input.tar.gz?token=synthetic"])("rejects unsafe input %s", (url) => expect(() => nativeInputRequest(url, checksum, env)).toThrow());
  it("rejects an unpinned input", () => expect(() => nativeInputRequest("https://sources.example.invalid/input.tar.gz", "", env)).toThrow());
});
