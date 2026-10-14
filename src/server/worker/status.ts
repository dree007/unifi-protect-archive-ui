import { and, eq, sql, type SQL } from "drizzle-orm";

import type { BackgroundComponent, BackgroundState, ProtectDetails } from "@/domain/background";
import { backgroundComponentStatus, type BackgroundComponentStatusRow } from "@/server/db/schema";
import type { Database } from "@/server/db/types";

import { LeadershipLostError } from "./leadership";

/**
 * Persisted state of the worker's components (table `background_component_status`). Written
 * only on real state changes – the heartbeat is the only periodic write – so a busy event
 * stream causes no status writes at all.
 *
 * Every write after the takeover is conditional on this instance's ID: if another instance
 * took the rows over, nothing is written and LeadershipLostError is raised (fail-closed).
 */

/** Database clock for timestamps: one time source for web and worker containers. */
export const DB_NOW: SQL = sql`now()`;

type Timestamp = Date | SQL | null;

export interface StatusPatch {
  state?: BackgroundState;
  lastStartedAt?: Timestamp;
  lastSucceededAt?: Timestamp;
  lastFailedAt?: Timestamp;
  lastErrorMessage?: string | null;
  nextRunAt?: Date | null;
  details?: Record<string, unknown> | null;
}

export interface TakeOverInput {
  protectState: BackgroundState;
  protectDetails: ProtectDetails;
  protectError: string | null;
}

export class StatusStore {
  constructor(
    private readonly db: Database,
    readonly instanceId: string,
  ) {}

  /**
   * Takes over all rows for this instance (only call while holding the worker lock). History
   * (last success/failure) is kept; a job left `running` by a dead process becomes `error`.
   */
  async takeOver({ protectState, protectDetails, protectError }: TakeOverInput): Promise<void> {
    const { instanceId } = this;
    const t = backgroundComponentStatus;
    await this.db.transaction(async (tx) => {
      await tx
        .insert(t)
        .values({
          component: "worker",
          instanceId,
          state: "starting",
          heartbeatAt: DB_NOW,
          instanceStartedAt: DB_NOW,
          lastStartedAt: DB_NOW,
        })
        .onConflictDoUpdate({
          target: t.component,
          set: {
            instanceId,
            state: "starting",
            heartbeatAt: DB_NOW,
            instanceStartedAt: DB_NOW,
            lastStartedAt: DB_NOW,
            lastErrorMessage: null,
            updatedAt: DB_NOW,
          },
        });
      await tx
        .insert(t)
        .values({
          component: "protect",
          instanceId,
          state: protectState,
          details: protectDetails as Record<string, unknown>,
          lastErrorMessage: protectError,
          lastFailedAt: protectError ? DB_NOW : null,
        })
        .onConflictDoUpdate({
          target: t.component,
          set: {
            instanceId,
            state: protectState,
            details: protectDetails as Record<string, unknown>,
            lastErrorMessage: protectError,
            lastFailedAt: protectError ? DB_NOW : sql`${t.lastFailedAt}`,
            updatedAt: DB_NOW,
          },
        });
      for (const component of ["archiveScan", "reconciliation"] as const) {
        await tx
          .insert(t)
          .values({ component, instanceId, state: "idle" })
          .onConflictDoUpdate({
            target: t.component,
            set: {
              instanceId,
              state: sql`case when ${t.state} = 'running' then 'error' else ${t.state} end`,
              lastFailedAt: sql`case when ${t.state} = 'running' then now() else ${t.lastFailedAt} end`,
              lastErrorMessage: sql`case when ${t.state} = 'running' then 'Interrupted: the worker ended before the run finished.' else ${t.lastErrorMessage} end`,
              nextRunAt: null,
              updatedAt: DB_NOW,
            },
          });
      }
    });
  }

  /** Conditional on this instance; throws LeadershipLostError if the row was taken over. */
  async update(component: BackgroundComponent, patch: StatusPatch): Promise<void> {
    const rows = await this.db
      .update(backgroundComponentStatus)
      .set({ ...patch, updatedAt: DB_NOW })
      .where(and(eq(backgroundComponentStatus.component, component), eq(backgroundComponentStatus.instanceId, this.instanceId)))
      .returning({ component: backgroundComponentStatus.component });
    if (rows.length === 0) {
      throw new LeadershipLostError(`Worker exclusivity lost: status of "${component}" belongs to another worker instance.`);
    }
  }

  async read(component: BackgroundComponent): Promise<BackgroundComponentStatusRow | undefined> {
    const [row] = await this.db
      .select()
      .from(backgroundComponentStatus)
      .where(eq(backgroundComponentStatus.component, component));
    return row;
  }
}
