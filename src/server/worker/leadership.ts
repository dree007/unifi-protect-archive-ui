import { Client } from "pg";

import { LOCK_KEYS } from "@/server/db/advisory-lock";

/**
 * Exclusivity of the background worker (docs/background-worker.md): a session-level advisory
 * lock on a dedicated connection that lives as long as the worker. PostgreSQL releases it when
 * that connection ends – process killed, network gone, server restarted.
 *
 * The worker cannot keep working without it, so the session is fail-closed: any sign that the
 * lock may be gone (connection error or end, failed heartbeat, lock no longer listed) calls
 * `onLost` exactly once, and the worker stops. It never tries to win the lock back; a
 * restarted process does that.
 */

/** Another worker holds the lock: this one must not start. */
export class WorkerAlreadyRunningError extends Error {
  override name = "WorkerAlreadyRunningError";
  constructor() {
    super("Another background worker is already active for this database.");
  }
}

/** The worker lock is gone, or the status rows belong to a newer instance. */
export class LeadershipLostError extends Error {
  override name = "LeadershipLostError";
}

export interface LeadershipOptions {
  databaseUrl: string;
  instanceId: string;
  onLost: (error: LeadershipLostError) => void;
  /** Upper bound for every statement on the lock connection (default 10 s). */
  queryTimeoutMs?: number;
}

const HELD = `exists (
  select 1 from pg_locks
  where locktype = 'advisory' and pid = pg_backend_pid() and granted and objsubid = 1
    and classid::bigint = ($1::bigint >> 32) and objid::bigint = ($1::bigint & 4294967295)
)`;

export class LeadershipSession {
  private lostError: LeadershipLostError | undefined;
  private closing = false;
  private pid = 0;

  private constructor(
    private readonly client: Client,
    private readonly options: LeadershipOptions,
  ) {}

  /** Connects and takes the worker lock; throws WorkerAlreadyRunningError if it is taken. */
  static async acquire(options: LeadershipOptions): Promise<LeadershipSession> {
    const client = new Client({
      connectionString: options.databaseUrl,
      // Detects a silently dropped connection (e.g. network partition) at the TCP level, too.
      keepAlive: true,
      query_timeout: options.queryTimeoutMs ?? 10_000,
      application_name: "unifi-archive-worker",
    });
    const session = new LeadershipSession(client, options);
    // Without listeners, a server restart would crash the process with an unhandled 'error'.
    client.on("error", (error) => session.lose(`database connection of the worker lock failed: ${error.message}`));
    client.on("end", () => session.lose("database connection of the worker lock closed"));
    try {
      await client.connect();
      const { rows } = await client.query<{ locked: boolean; pid: number }>("select pg_try_advisory_lock($1) as locked, pg_backend_pid() as pid", [LOCK_KEYS.worker]);
      if (!rows[0].locked) throw new WorkerAlreadyRunningError();
      session.pid = rows[0].pid;
    } catch (error) {
      session.closing = true;
      await client.end().catch(() => {});
      throw error;
    }
    return session;
  }

  get lost(): boolean {
    return this.lostError !== undefined;
  }

  get backendPid(): number {
    return this.pid;
  }

  /** Throws if the lock may be gone: call before every job, so a lost lock runs nothing more. */
  async assertHeld(): Promise<void> {
    if (this.lostError) throw this.lostError;
    let held: boolean;
    try {
      const { rows } = await this.client.query<{ held: boolean }>(`select ${HELD} as held`, [LOCK_KEYS.worker]);
      held = rows[0].held;
    } catch (error) {
      throw this.lose(`worker lock check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!held) throw this.lose("worker lock is no longer held");
  }

  /**
   * Heartbeat on the lock connection itself: succeeds only if the connection lives, the lock
   * is held and the worker row still belongs to this instance. Any failure is fatal.
   */
  async heartbeat(): Promise<Date> {
    if (this.lostError) throw this.lostError;
    let rows: { heartbeat_at: Date }[];
    try {
      ({ rows } = await this.client.query<{ heartbeat_at: Date }>(
        `update background_component_status set heartbeat_at = now(), updated_at = now()
         where component = 'worker' and instance_id = $2 and ${HELD}
         returning heartbeat_at`,
        [LOCK_KEYS.worker, this.options.instanceId],
      ));
    } catch (error) {
      throw this.lose(`heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (rows.length === 0) throw this.lose("heartbeat rejected: worker lock or worker status taken over");
    return rows[0].heartbeat_at;
  }

  /** Takes a further lock on this session (lost together with the worker lock). */
  async tryLock(key: number): Promise<boolean> {
    const { rows } = await this.client.query<{ locked: boolean }>("select pg_try_advisory_lock($1) as locked", [key]);
    return rows[0].locked;
  }

  async unlock(key: number): Promise<void> {
    if (this.lostError) return;
    await this.client.query("select pg_advisory_unlock($1)", [key]);
  }

  /** Releases every lock of this session and closes it. */
  async release(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (!this.lostError) await this.client.query("select pg_advisory_unlock_all()").catch(() => {});
    await this.client.end().catch(() => {});
  }

  private lose(reason: string): LeadershipLostError {
    if (this.lostError) return this.lostError;
    if (this.closing) return new LeadershipLostError(reason);
    this.lostError = new LeadershipLostError(`Worker exclusivity lost: ${reason}.`);
    this.options.onLost(this.lostError);
    return this.lostError;
  }
}
