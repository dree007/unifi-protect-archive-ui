/**
 * HTTP `Range` header for video streaming (RFC 9110 §14). Pure, no I/O.
 *
 * Deliberately strict and small: exactly one byte range is served. Every other `Range` header –
 * several ranges, other units, broken syntax, ranges outside the file – is answered with 416
 * and `Content-Range: bytes *\/SIZE`. (RFC 9110 would allow ignoring an unparsable header and
 * sending 200; browsers never send one, and a clear 416 is easier to reason about.
 * Multipart/byteranges responses are never produced.)
 */

export type RangeResult =
  /** No `Range` header: send the whole file (200). */
  | { kind: "none" }
  /** One satisfiable range, inclusive bounds, `end` already clamped to the file (206). */
  | { kind: "single"; start: number; end: number }
  /** 416. `reason` is for tests and debugging only. */
  | { kind: "unsatisfiable"; reason: "syntax" | "unit" | "multiple" | "not-satisfiable" };

const SPEC = /^(\d*)-(\d*)$/;

export function parseRange(header: string | null | undefined, size: number): RangeResult {
  if (header === null || header === undefined) return { kind: "none" };
  const value = header.trim();
  const equals = value.indexOf("=");
  if (equals < 0) return { kind: "unsatisfiable", reason: "syntax" };
  if (value.slice(0, equals).trim().toLowerCase() !== "bytes") return { kind: "unsatisfiable", reason: "unit" };

  const specs = value.slice(equals + 1).split(",");
  if (specs.length > 1) return { kind: "unsatisfiable", reason: "multiple" };
  const match = SPEC.exec(specs[0].trim());
  if (!match || (match[1] === "" && match[2] === "")) return { kind: "unsatisfiable", reason: "syntax" };

  // Digit strings only; very large values become huge numbers (or Infinity) and are handled
  // by the comparisons below without precision concerns that matter here.
  const first = match[1] === "" ? undefined : Number(match[1]);
  const last = match[2] === "" ? undefined : Number(match[2]);

  if (first === undefined) {
    // Suffix range `-N`: the last N bytes (all of them if N exceeds the size).
    const suffix = last!;
    if (suffix === 0 || size === 0) return { kind: "unsatisfiable", reason: "not-satisfiable" };
    return { kind: "single", start: Math.max(0, size - suffix), end: size - 1 };
  }
  if (last !== undefined && last < first) return { kind: "unsatisfiable", reason: "syntax" };
  if (first >= size) return { kind: "unsatisfiable", reason: "not-satisfiable" };
  return { kind: "single", start: first, end: last === undefined ? size - 1 : Math.min(last, size - 1) };
}
