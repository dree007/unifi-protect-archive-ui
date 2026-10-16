/**
 * Parser for clip file names written by UniFi Protect's archive export:
 *
 *   <Camera> <M>-<D>-<YYYY>, <h>.<mm>.<ss><am|pm> <zone> - <M>-<D>-<YYYY>, <h>.<mm>.<ss><am|pm> <zone>.mp4
 *   Einfahrt 3-29-2026, 1.01.05pm GMT+2 - 3-29-2026, 1.02.18pm GMT+2.mp4
 *   Kitchen 9-23-2026, 7.06.40pm CDT - 9-23-2026, 7.11.48pm CDT.mp4
 *
 * `<zone>` is either a GMT offset (`GMT±H[:MM]`, bare `GMT`) or one of the abbreviations in
 * TIME_ZONE_ABBREVIATIONS. Times are converted to absolute instants using the zone of each
 * timestamp; the server time zone is never consulted. Pure module: no I/O, no dependencies.
 */

export interface ParsedClipFileName {
  /** Camera name as written in the file name (Unicode NFC-normalized, trimmed). */
  cameraName: string;
  startAt: Date;
  endAt: Date;
  durationMs: number;
  /** Calendar date of the start in the file's own offset, `YYYY-MM-DD` (for the day-folder check). */
  startLocalDate: string;
}

export type FileNameErrorCode =
  | "notMp4"
  | "unrecognizedFormat"
  | "invalidDate"
  | "invalidTime"
  | "invalidOffset"
  | "unknownTimeZone"
  | "endBeforeStart";

export interface FileNameError {
  code: FileNameErrorCode;
  message: string;
}

export type ParseFileNameResult =
  | { ok: true; value: ParsedClipFileName }
  | { ok: false; error: FileNameError };

/**
 * UTC offsets (minutes) of the zone abbreviations UniFi Protect writes instead of a GMT offset.
 * The names come from the en-US short time zone names (CLDR/ICU) of the exporting browser,
 * which uses an abbreviation for the US/Canadian/Caribbean zones and UTC, and `GMT±H` for
 * every other zone. Each listed name has exactly one offset there. Anything else (`CET`, `IST`,
 * `BST`, …) is rejected as unknown or ambiguous instead of being guessed.
 */
export const TIME_ZONE_ABBREVIATIONS: Readonly<Record<string, number>> = {
  UTC: 0,
  GMT: 0,
  ADT: -3 * 60,
  AST: -4 * 60,
  EDT: -4 * 60,
  EST: -5 * 60,
  CDT: -5 * 60,
  CST: -6 * 60,
  MDT: -6 * 60,
  MST: -7 * 60,
  PDT: -7 * 60,
  PST: -8 * 60,
  AKDT: -8 * 60,
  AKST: -9 * 60,
  HDT: -9 * 60,
  HADT: -9 * 60,
  HST: -10 * 60,
  HAST: -10 * 60,
};

// One timestamp, e.g. `3-29-2026, 1.01.05pm GMT+2` or `9-23-2026, 7.06.40pm CDT`. Offset
// minutes are optional (`GMT+5:30`); a bare `GMT` means UTC. Any other letters-only zone is
// captured and resolved through TIME_ZONE_ABBREVIATIONS.
const TIMESTAMP =
  String.raw`(\d{1,2})-(\d{1,2})-(\d{4}), (\d{1,2})\.(\d{2})\.(\d{2}) ?([ap]m) (?:GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?|([a-z]{2,5}))`;
const TIMESTAMP_GROUPS = 11;

// The camera name is everything before the start timestamp. The pattern is anchored at both
// ends and the timestamps are very specific, so names with spaces, dashes, digits or Unicode
// are captured completely instead of being split at the first space.
const FILE_NAME = new RegExp(String.raw`^(.+?) ${TIMESTAMP} - ${TIMESTAMP}\.mp4$`, "iu");

const MAX_OFFSET_MINUTES = 14 * 60;

const fail = (code: FileNameErrorCode, message: string): ParseFileNameResult => ({
  ok: false,
  error: { code, message },
});

type TimestampParts = [
  month: string,
  day: string,
  year: string,
  hour: string,
  minute: string,
  second: string,
  meridiem: string,
  offsetSign: string | undefined,
  offsetHours: string | undefined,
  offsetMinutes: string | undefined,
  abbreviation: string | undefined,
];

type TimestampResult =
  | { ok: true; instant: Date; localDate: string }
  | { ok: false; error: FileNameError };

function toInstant(parts: TimestampParts, label: "start" | "end"): TimestampResult {
  const [month, day, year, hour, minute, second, meridiem, sign, offsetH, offsetM, abbreviation] = parts;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h12 = Number(hour);
  const mi = Number(minute);
  const s = Number(second);

  // Date.UTC normalizes overflow (Feb 30 → Mar 2); a round trip detects invalid dates.
  const calendar = new Date(Date.UTC(y, mo - 1, d));
  if (
    mo < 1 ||
    mo > 12 ||
    d < 1 ||
    calendar.getUTCFullYear() !== y ||
    calendar.getUTCMonth() !== mo - 1 ||
    calendar.getUTCDate() !== d
  ) {
    return { ok: false, error: { code: "invalidDate", message: `invalid ${label} date ${month}-${day}-${year}` } };
  }
  if (h12 < 1 || h12 > 12 || mi > 59 || s > 59) {
    return {
      ok: false,
      error: { code: "invalidTime", message: `invalid ${label} time ${hour}.${minute}.${second}${meridiem}` },
    };
  }

  let offsetMinutes: number;
  if (abbreviation) {
    const known = TIME_ZONE_ABBREVIATIONS[abbreviation.toUpperCase()];
    if (known === undefined) {
      return {
        ok: false,
        error: { code: "unknownTimeZone", message: `unknown or ambiguous ${label} time zone ${abbreviation}` },
      };
    }
    offsetMinutes = known;
  } else {
    offsetMinutes = sign ? (sign === "-" ? -1 : 1) * (Number(offsetH) * 60 + Number(offsetM ?? 0)) : 0;
    if (Math.abs(offsetMinutes) > MAX_OFFSET_MINUTES || Number(offsetM ?? 0) > 59) {
      return { ok: false, error: { code: "invalidOffset", message: `invalid ${label} GMT offset` } };
    }
  }

  // 12-hour clock: 12am is midnight (0), 12pm is noon (12).
  const isPm = meridiem.toLowerCase() === "pm";
  const h24 = (h12 % 12) + (isPm ? 12 : 0);
  // Local wall-clock time in the given offset → UTC instant.
  const instant = new Date(Date.UTC(y, mo - 1, d, h24, mi, s) - offsetMinutes * 60_000);
  const localDate = `${year}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { ok: true, instant, localDate };
}

export function parseClipFileName(fileName: string): ParseFileNameResult {
  if (!/\.mp4$/i.test(fileName)) {
    return fail("notMp4", "not an .mp4 file");
  }
  const match = FILE_NAME.exec(fileName);
  if (!match) {
    return fail(
      "unrecognizedFormat",
      "file name does not match the UniFi format '<Camera> M-D-YYYY, h.mm.ss[am|pm] GMT±H|<zone> - ….mp4'",
    );
  }

  const cameraName = match[1].normalize("NFC").trim();
  if (!cameraName) return fail("unrecognizedFormat", "camera name is missing");

  const start = toInstant(match.slice(2, 2 + TIMESTAMP_GROUPS) as TimestampParts, "start");
  if (!start.ok) return start;
  const end = toInstant(match.slice(2 + TIMESTAMP_GROUPS, 2 + 2 * TIMESTAMP_GROUPS) as TimestampParts, "end");
  if (!end.ok) return end;

  const durationMs = end.instant.getTime() - start.instant.getTime();
  if (durationMs < 0) {
    return fail("endBeforeStart", "end is before start");
  }

  return {
    ok: true,
    value: {
      cameraName,
      startAt: start.instant,
      endAt: end.instant,
      durationMs,
      startLocalDate: start.localDate,
    },
  };
}
