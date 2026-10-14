/**
 * Runtime validation of JSON received from the UniFi Protect Integration API. External data
 * is never trusted: only the fields we use are checked and copied into our own types. Unknown
 * extra fields are ignored; unknown enum-like values (states, detection types) are kept as
 * strings so that new Protect versions do not break the integration.
 */

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Keeps the non-empty strings of an array; `undefined` if the value is not an array. */
export function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

/** Response did not have the expected shape. */
export class ProtectPayloadError extends Error {
  override name = "ProtectPayloadError";
}

// --- GET /meta/info ------------------------------------------------------------------------

export interface ProtectMetaInfo {
  applicationVersion: string;
}

export function parseMetaInfo(body: unknown): ProtectMetaInfo {
  const applicationVersion = isObject(body) ? nonEmptyString(body.applicationVersion) : undefined;
  if (!applicationVersion) {
    throw new ProtectPayloadError("meta/info response has no applicationVersion.");
  }
  return { applicationVersion };
}

// --- GET /cameras --------------------------------------------------------------------------

export interface ProtectCamera {
  /** Protect device ID: the stable identity. */
  id: string;
  name: string;
  /** Raw Protect state, e.g. `CONNECTED`, `DISCONNECTED`; unknown values are kept. */
  state: string;
  mac: string | null;
  /**
   * Configured smart detection object types (`smartDetectSettings.objectTypes`), falling back
   * to the supported types (`featureFlags.smartDetectTypes`) if not configured/reported.
   */
  smartDetectTypes: string[];
}

export interface CameraListResult {
  cameras: ProtectCamera[];
  /** Entries that could not be used, with the reason (the sync continues without them). */
  invalid: { index: number; reason: string }[];
}

export function parseCamera(value: unknown): ProtectCamera | string {
  if (!isObject(value)) return "not an object";
  const id = nonEmptyString(value.id);
  if (!id) return "missing id";
  const state = nonEmptyString(value.state);
  if (!state) return `camera ${id}: missing state`;
  // A camera without a name is still a camera; show its ID instead of dropping it.
  const name = nonEmptyString(value.name)?.trim() ?? id;
  const configured = isObject(value.smartDetectSettings)
    ? stringArray(value.smartDetectSettings.objectTypes)
    : undefined;
  const supported = isObject(value.featureFlags) ? stringArray(value.featureFlags.smartDetectTypes) : undefined;
  return {
    id,
    name,
    state,
    mac: nonEmptyString(value.mac) ?? null,
    smartDetectTypes: [...new Set(configured ?? supported ?? [])],
  };
}

export function parseCameraList(body: unknown): CameraListResult {
  if (!Array.isArray(body)) {
    throw new ProtectPayloadError("cameras response is not an array.");
  }
  const result: CameraListResult = { cameras: [], invalid: [] };
  body.forEach((entry, index) => {
    const parsed = parseCamera(entry);
    if (typeof parsed === "string") result.invalid.push({ index, reason: parsed });
    else result.cameras.push(parsed);
  });
  return result;
}
