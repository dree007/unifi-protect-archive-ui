import "server-only";

import type { ProtectEventRow } from "@/server/db/schema";
import type { Database } from "@/server/db/types";
import { findCameraByProtectDeviceId } from "@/server/repositories/cameras";
import {
  findProtectEventByProtectEventId,
  upsertProtectEvent,
  type ProtectEventSnapshot,
} from "@/server/repositories/protect-events";

import { parseProtectMessage, type ProtectEventMessage } from "./event-parser";
import { silentProtectLogger, type ProtectLogger } from "./logger";

export type IngestResult =
  | { kind: "stored"; event: ProtectEventRow; cameraName: string | undefined }
  | { kind: "ignored"; reason: string }
  | { kind: "invalid"; reason: string };

export interface ProtectEventIngestOptions {
  db: Database;
  logger?: ProtectLogger;
  /**
   * Re-syncs cameras when an event references an unknown device, at most once per cooldown
   * (never once per message). Optional: without it, unknown devices are stored with cameraId NULL.
   */
  resyncCameras?: () => Promise<unknown>;
  resyncCooldownMs?: number;
  now?: () => Date;
}

/**
 * Turns WebSocket messages into `protect_events` rows. Callers must feed messages one at a
 * time (the collector processes them sequentially), so updates of one event apply in order.
 * Never throws for bad messages; database errors propagate to the caller.
 */
export class ProtectEventIngest {
  private readonly db: Database;
  private readonly logger: ProtectLogger;
  private readonly resyncCameras?: () => Promise<unknown>;
  private readonly resyncCooldownMs: number;
  private readonly now: () => Date;
  private lastResyncAt: number | undefined;
  private readonly warnedDevices = new Set<string>();

  constructor({ db, logger = silentProtectLogger, resyncCameras, resyncCooldownMs = 5 * 60_000, now }: ProtectEventIngestOptions) {
    this.db = db;
    this.logger = logger;
    this.resyncCameras = resyncCameras;
    this.resyncCooldownMs = resyncCooldownMs;
    this.now = now ?? (() => new Date());
  }

  async handle(raw: string): Promise<IngestResult> {
    const receivedAt = this.now();
    const parsed = parseProtectMessage(raw);
    if (parsed.kind === "ignored") {
      this.logger.debug(`ignored message (${parsed.reason})`);
      return parsed;
    }
    if (parsed.kind === "invalid") {
      this.logger.warn(`Skipped Protect message: ${parsed.reason}`);
      return parsed;
    }

    const snapshot = await this.complete(parsed.event);
    if (!snapshot) {
      const reason = `update for unknown event ${parsed.event.protectEventId} without start/device/type`;
      this.logger.warn(`Skipped Protect message: ${reason}`);
      return { kind: "invalid", reason };
    }

    const camera = await this.findCamera(snapshot.protectDeviceId);
    const event = await upsertProtectEvent({ ...snapshot, cameraId: camera?.id ?? null, receivedAt }, this.db);
    this.logger.debug(describeEvent(parsed.event, event, camera?.name));
    return { kind: "stored", event, cameraName: camera?.name };
  }

  /** Complete messages are used as they are; partial updates are filled from the stored event. */
  private async complete(message: ProtectEventMessage): Promise<Omit<ProtectEventSnapshot, "receivedAt"> | undefined> {
    const { protectEventId, eventType, protectDeviceId, startAt, endAt, smartDetectTypes } = message;
    if (eventType && protectDeviceId && startAt) {
      return { protectEventId, eventType, protectDeviceId, startAt, endAt, smartDetectTypes };
    }
    const stored = await findProtectEventByProtectEventId(protectEventId, this.db);
    if (!stored) return undefined;
    return {
      protectEventId,
      eventType: eventType ?? stored.eventType,
      protectDeviceId: protectDeviceId ?? stored.protectDeviceId,
      startAt: startAt ?? stored.startAt,
      endAt,
      smartDetectTypes,
    };
  }

  private async findCamera(protectDeviceId: string) {
    const camera = await findCameraByProtectDeviceId(protectDeviceId, this.db);
    if (camera) return camera;

    // A camera added in Protect after the last sync: re-sync once per cooldown, then retry.
    const now = this.now().getTime();
    if (this.resyncCameras && (this.lastResyncAt === undefined || now - this.lastResyncAt >= this.resyncCooldownMs)) {
      this.lastResyncAt = now;
      this.logger.info(`Unknown Protect device ${protectDeviceId}: re-syncing cameras.`);
      try {
        await this.resyncCameras();
        const synced = await findCameraByProtectDeviceId(protectDeviceId, this.db);
        if (synced) return synced;
      } catch (error) {
        this.logger.warn(`Camera re-sync failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!this.warnedDevices.has(protectDeviceId)) {
      this.warnedDevices.add(protectDeviceId);
      this.logger.warn(`Protect device ${protectDeviceId} is not a known camera; its events are stored without camera.`);
    }
    return undefined;
  }
}

function describeEvent(message: ProtectEventMessage, event: ProtectEventRow, cameraName: string | undefined): string {
  const types = event.smartDetectTypes.length > 0 ? event.smartDetectTypes.join(", ").toUpperCase() : event.eventType;
  const state = event.endAt ? `ended ${event.endAt.toISOString()}` : "ongoing";
  return `${types}  ${cameraName ?? event.protectDeviceId}  ${event.startAt.toISOString()}  event ${event.protectEventId.slice(0, 8)}… (${message.action}, ${state})`;
}
