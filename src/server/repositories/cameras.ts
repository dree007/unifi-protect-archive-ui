import "server-only";

import { asc, eq, getTableColumns, sql } from "drizzle-orm";

import type { CameraState } from "@/domain/types";
import { getDb } from "@/server/db/client";
import { cameras, type CameraRow } from "@/server/db/schema";
import { excluded } from "@/server/db/sql";
import type { DbExecutor } from "@/server/db/types";

/**
 * A camera as currently reported by Protect. Name, states and detection types are taken as
 * given; `model`, `mac` and `lastSeenAt` are never cleared by a snapshot that lacks them
 * (`lastSeenAt` only moves forward).
 */
export interface CameraInput {
  protectDeviceId: string;
  name: string;
  state: CameraState;
  /** Raw Protect state; any string. */
  protectState?: string | null;
  model?: string | null;
  mac?: string | null;
  smartDetectTypes?: readonly string[];
  lastSeenAt?: Date | null;
}

export type CameraWriteOutcome = "inserted" | "updated" | "unchanged";

/** Columns whose change counts as an update of the camera. */
const CONTENT_COLUMNS = [
  cameras.name,
  cameras.state,
  cameras.protectState,
  cameras.model,
  cameras.mac,
  cameras.smartDetectTypes,
].map((column) => column.name);

const row = (alias: string) => sql.raw(`(${CONTENT_COLUMNS.map((name) => `${alias}."${name}"`).join(", ")})`);

export async function findCameraByProtectDeviceId(
  protectDeviceId: string,
  db: DbExecutor = getDb(),
): Promise<CameraRow | undefined> {
  const [found] = await db
    .select()
    .from(cameras)
    .where(eq(cameras.protectDeviceId, protectDeviceId))
    .limit(1);
  return found;
}

export async function listCameras(db: DbExecutor = getDb()): Promise<CameraRow[]> {
  return db.select().from(cameras).orderBy(asc(cameras.name), asc(cameras.protectDeviceId));
}

/**
 * Inserts cameras or updates known ones (same Protect device ID) in one statement; the
 * internal ID never changes. `updatedAt` changes only on real changes. Returns the resulting
 * rows with whether each was inserted, updated or unchanged. Device IDs must be unique.
 */
export async function upsertCameras(
  inputs: readonly CameraInput[],
  db: DbExecutor = getDb(),
): Promise<{ camera: CameraRow; outcome: CameraWriteOutcome }[]> {
  if (inputs.length === 0) return [];
  // Values as they will be after the update (model/mac keep their old value when absent).
  const proposed = sql.raw(
    `(excluded."name", excluded."state", excluded."protect_state", ` +
      `coalesce(excluded."model", cameras."model"), coalesce(excluded."mac", cameras."mac"), ` +
      `excluded."smart_detect_types")`,
  );
  const rows = await db
    .insert(cameras)
    .values(
      inputs.map((input) => ({
        protectDeviceId: input.protectDeviceId,
        name: input.name,
        state: input.state,
        protectState: input.protectState ?? null,
        model: input.model ?? null,
        mac: input.mac ?? null,
        smartDetectTypes: [...(input.smartDetectTypes ?? [])],
        lastSeenAt: input.lastSeenAt ?? null,
      })),
    )
    .onConflictDoUpdate({
      target: cameras.protectDeviceId,
      set: {
        name: excluded(cameras.name),
        state: excluded(cameras.state),
        protectState: excluded(cameras.protectState),
        model: sql`coalesce(${excluded(cameras.model)}, ${cameras.model})`,
        mac: sql`coalesce(${excluded(cameras.mac)}, ${cameras.mac})`,
        smartDetectTypes: excluded(cameras.smartDetectTypes),
        // greatest() ignores NULL: a snapshot without lastSeenAt keeps the old value.
        lastSeenAt: sql`greatest(${cameras.lastSeenAt}, ${excluded(cameras.lastSeenAt)})`,
        updatedAt: sql`case when ${row("cameras")} is distinct from ${proposed} then now() else ${cameras.updatedAt} end`,
      },
    })
    // PostgreSQL 18 `RETURNING old.*`: `old` is null for inserted rows.
    .returning({
      ...getTableColumns(cameras),
      inserted: sql<boolean>`old.id is null`,
      changed: sql<boolean>`${row("old")} is distinct from ${row("new")}`,
    });
  return rows.map(({ inserted, changed, ...camera }) => ({
    camera,
    outcome: inserted ? "inserted" : changed ? "updated" : "unchanged",
  }));
}

/** Single-camera variant of {@link upsertCameras}. */
export async function upsertCamera(input: CameraInput, db: DbExecutor = getDb()): Promise<CameraRow> {
  const [result] = await upsertCameras([input], db);
  return result.camera;
}
