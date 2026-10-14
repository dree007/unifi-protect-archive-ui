/**
 * Parser for messages of the Protect event WebSocket
 * (`/proxy/protect/integration/v1/subscribe/events`), e.g.
 *
 *   {"type":"add","item":{"id":"…","modelKey":"event","type":"smartDetectZone",
 *    "start":1768471200000,"device":"660000000000000000000001","smartDetectTypes":["person"]}}
 *
 * followed by `update` messages with the same item ID (the last one with `end`). Pure module.
 */
import { isObject, nonEmptyString, stringArray } from "./payloads";

/** What an event message says about one Protect event; fields absent in the message are undefined. */
export interface ProtectEventMessage {
  action: "add" | "update";
  protectEventId: string;
  /** Protect event type, kept as received (e.g. `smartDetectZone`). */
  eventType?: string;
  protectDeviceId?: string;
  startAt?: Date;
  /** `null` if explicitly null, `undefined` if not part of the message. */
  endAt?: Date | null;
  /** Any strings, including types unknown to us (new Protect versions, audio detections). */
  smartDetectTypes?: string[];
}

export type ParsedProtectMessage =
  | { kind: "event"; event: ProtectEventMessage }
  /** Valid but not relevant for us (other model, other message type). */
  | { kind: "ignored"; reason: string }
  /** Broken or unusable; worth a warning. */
  | { kind: "invalid"; reason: string };

// Plausible epoch-millisecond range: 2000-01-01 … 2100-01-01. Catches seconds-instead-of-ms
// and garbage values.
const MIN_MS = Date.UTC(2000, 0, 1);
const MAX_MS = Date.UTC(2100, 0, 1);

function timestamp(value: unknown): Date | "invalid" | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < MIN_MS || value > MAX_MS) {
    return "invalid";
  }
  return new Date(value);
}

const invalid = (reason: string): ParsedProtectMessage => ({ kind: "invalid", reason });

export function parseProtectMessage(raw: string): ParsedProtectMessage {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return invalid("not valid JSON");
  }
  if (!isObject(message)) return invalid("message is not a JSON object");

  const action = message.type;
  if (action !== "add" && action !== "update") {
    return { kind: "ignored", reason: `message type ${JSON.stringify(action)}` };
  }
  const item = message.item;
  if (!isObject(item)) return invalid(`${action} without item`);
  if (item.modelKey !== "event") {
    return { kind: "ignored", reason: `modelKey ${JSON.stringify(item.modelKey)}` };
  }

  const protectEventId = nonEmptyString(item.id);
  if (!protectEventId) return invalid(`${action} event without id`);

  const startAt = timestamp(item.start);
  if (startAt === "invalid") return invalid(`event ${protectEventId}: invalid start`);
  const endAt = item.end === null ? null : timestamp(item.end);
  if (endAt === "invalid") return invalid(`event ${protectEventId}: invalid end`);
  if (startAt && endAt && endAt < startAt) return invalid(`event ${protectEventId}: end before start`);

  const eventType = nonEmptyString(item.type);
  const protectDeviceId = nonEmptyString(item.device);
  // A new event must be complete; updates may in principle be partial and are completed from
  // the stored event by the ingest step.
  if (action === "add") {
    if (!startAt) return invalid(`add event ${protectEventId}: missing start`);
    if (!protectDeviceId) return invalid(`add event ${protectEventId}: missing device`);
    if (!eventType) return invalid(`add event ${protectEventId}: missing type`);
  }

  return {
    kind: "event",
    event: {
      action,
      protectEventId,
      eventType,
      protectDeviceId,
      startAt,
      endAt,
      smartDetectTypes: stringArray(item.smartDetectTypes),
    },
  };
}
